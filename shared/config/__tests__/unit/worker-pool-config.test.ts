/**
 * Tests for Worker Pool Configuration
 *
 * Covers:
 * - Platform detection flags (Fly.io, Railway, Render, constrained)
 * - Pool size resolution with env var overrides
 * - Max queue size resolution with env var overrides
 * - Task timeout resolution with env var overrides
 * - WORKER_POOL_CONFIG composite object
 *
 * @see shared/config/src/worker-pool-config.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Store original env to restore after each test
const originalEnv = { ...process.env };

/**
 * Helper to import worker-pool-config with fresh module evaluation.
 * Since the config is computed at module load time from process.env,
 * we must reset modules and re-import after setting env vars.
 */
function importWithEnv(envOverrides: Record<string, string | undefined> = {}) {
  // Apply env overrides
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Use isolateModules to get a fresh evaluation
  let config: typeof import('../../src/worker-pool-config');
  jest.isolateModules(() => {
    config = require('../../src/worker-pool-config');
  });
  return config!;
}

describe('Worker Pool Configuration', () => {
  beforeEach(() => {
    // Clear all platform env vars before each test
    delete process.env.FLY_APP_NAME;
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RENDER_SERVICE_NAME;
    delete process.env.CONSTRAINED_MEMORY;
    delete process.env.WORKER_POOL_SIZE;
    delete process.env.WORKER_POOL_MAX_QUEUE_SIZE;
    delete process.env.WORKER_POOL_TASK_TIMEOUT_MS;
  });

  afterEach(() => {
    // Restore original environment
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  // ===========================================================================
  // Platform Detection
  // ===========================================================================

  describe('platform detection', () => {
    it('should detect Fly.io via FLY_APP_NAME', () => {
      const config = importWithEnv({ FLY_APP_NAME: 'my-app' });
      expect(config.IS_FLY_IO).toBe(true);
      expect(config.IS_CONSTRAINED_HOST).toBe(true);
      expect(config.PLATFORM_NAME).toBe('fly.io');
    });

    it('should detect Railway via RAILWAY_ENVIRONMENT', () => {
      const config = importWithEnv({ RAILWAY_ENVIRONMENT: 'production' });
      expect(config.IS_RAILWAY).toBe(true);
      expect(config.IS_CONSTRAINED_HOST).toBe(true);
      expect(config.PLATFORM_NAME).toBe('railway');
    });

    it('should detect Render via RENDER_SERVICE_NAME', () => {
      const config = importWithEnv({ RENDER_SERVICE_NAME: 'my-service' });
      expect(config.IS_RENDER).toBe(true);
      expect(config.IS_CONSTRAINED_HOST).toBe(true);
      expect(config.PLATFORM_NAME).toBe('render');
    });

    it('should detect constrained memory via CONSTRAINED_MEMORY=true', () => {
      const config = importWithEnv({ CONSTRAINED_MEMORY: 'true' });
      expect(config.IS_CONSTRAINED_HOST).toBe(true);
      expect(config.PLATFORM_NAME).toBe('constrained');
    });

    it('should default to standard platform when no platform env vars set', () => {
      const config = importWithEnv({});
      expect(config.IS_FLY_IO).toBe(false);
      expect(config.IS_RAILWAY).toBe(false);
      expect(config.IS_RENDER).toBe(false);
      expect(config.IS_CONSTRAINED_HOST).toBe(false);
      expect(config.PLATFORM_NAME).toBe('standard');
    });

    it('should prioritize Fly.io in PLATFORM_NAME when multiple platforms detected', () => {
      const config = importWithEnv({
        FLY_APP_NAME: 'app',
        RAILWAY_ENVIRONMENT: 'prod',
      });
      // Fly.io takes priority in the ternary chain
      expect(config.PLATFORM_NAME).toBe('fly.io');
    });
  });

  // ===========================================================================
  // Pool Size Resolution
  // ===========================================================================

  describe('pool size', () => {
    it('should use env override when WORKER_POOL_SIZE is set', () => {
      const config = importWithEnv({ WORKER_POOL_SIZE: '8' });
      expect(config.WORKER_POOL_CONFIG.poolSize).toBe(8);
    });

    it('should use 2 workers on Fly.io (256MB tier)', () => {
      const config = importWithEnv({ FLY_APP_NAME: 'my-app' });
      expect(config.WORKER_POOL_CONFIG.poolSize).toBe(2);
    });

    it('should use 3 workers on other constrained hosts', () => {
      const config = importWithEnv({ CONSTRAINED_MEMORY: 'true' });
      expect(config.WORKER_POOL_CONFIG.poolSize).toBe(3);
    });

    it('should use 4 workers on standard hosts', () => {
      const config = importWithEnv({});
      expect(config.WORKER_POOL_CONFIG.poolSize).toBe(4);
    });

    it('should ignore env override of 0 (treated as unset)', () => {
      const config = importWithEnv({ WORKER_POOL_SIZE: '0' });
      // 0 is not > 0, so falls through to platform default
      expect(config.WORKER_POOL_CONFIG.poolSize).toBe(4);
    });

    it('should ignore invalid env override (NaN)', () => {
      const config = importWithEnv({ WORKER_POOL_SIZE: 'not-a-number' });
      expect(config.WORKER_POOL_CONFIG.poolSize).toBe(4);
    });
  });

  // ===========================================================================
  // Max Queue Size Resolution
  // ===========================================================================

  describe('max queue size', () => {
    it('should use env override when WORKER_POOL_MAX_QUEUE_SIZE is set', () => {
      const config = importWithEnv({ WORKER_POOL_MAX_QUEUE_SIZE: '500' });
      expect(config.WORKER_POOL_CONFIG.maxQueueSize).toBe(500);
    });

    it('should use 300 on constrained hosts', () => {
      const config = importWithEnv({ CONSTRAINED_MEMORY: 'true' });
      expect(config.WORKER_POOL_CONFIG.maxQueueSize).toBe(300);
    });

    it('should use 1000 on standard hosts', () => {
      const config = importWithEnv({});
      expect(config.WORKER_POOL_CONFIG.maxQueueSize).toBe(1000);
    });
  });

  // ===========================================================================
  // Task Timeout Resolution
  // ===========================================================================

  describe('task timeout', () => {
    it('should use env override when WORKER_POOL_TASK_TIMEOUT_MS is set', () => {
      const config = importWithEnv({ WORKER_POOL_TASK_TIMEOUT_MS: '60000' });
      expect(config.WORKER_POOL_CONFIG.taskTimeout).toBe(60000);
    });

    it('should default to 30000ms', () => {
      const config = importWithEnv({});
      expect(config.WORKER_POOL_CONFIG.taskTimeout).toBe(30000);
    });

    it('should ignore env override of 0', () => {
      const config = importWithEnv({ WORKER_POOL_TASK_TIMEOUT_MS: '0' });
      // 0 is not > 0, so falls through to default
      expect(config.WORKER_POOL_CONFIG.taskTimeout).toBe(30000);
    });
  });

  // ===========================================================================
  // WORKER_POOL_CONFIG Composite
  // ===========================================================================

  describe('WORKER_POOL_CONFIG', () => {
    it('should have all required properties', () => {
      const config = importWithEnv({});
      expect(config.WORKER_POOL_CONFIG).toHaveProperty('poolSize');
      expect(config.WORKER_POOL_CONFIG).toHaveProperty('maxQueueSize');
      expect(config.WORKER_POOL_CONFIG).toHaveProperty('taskTimeout');
    });

    it('should have positive values for all properties', () => {
      const config = importWithEnv({});
      expect(config.WORKER_POOL_CONFIG.poolSize).toBeGreaterThan(0);
      expect(config.WORKER_POOL_CONFIG.maxQueueSize).toBeGreaterThan(0);
      expect(config.WORKER_POOL_CONFIG.taskTimeout).toBeGreaterThan(0);
    });
  });
});
