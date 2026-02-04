/**
 * Integration Test Harness
 *
 * Manages lifecycle of components for integration testing.
 * Uses real Redis (via redis-memory-server) for stream communication.
 */

import Redis from 'ioredis';
import { getRedisUrl } from '../redis-test-setup';

export interface TestComponent {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class IntegrationTestHarness {
  private redis: Redis | null = null;
  private components: TestComponent[] = [];
  private cleanupCallbacks: (() => Promise<void>)[] = [];

  /**
   * Get Redis client connected to test server
   */
  async getRedis(): Promise<Redis> {
    if (!this.redis) {
      const redis = new Redis(getRedisUrl(), {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      try {
        await redis.connect();
        this.redis = redis; // Only set after successful connection
      } catch (error) {
        // Clean up failed connection attempt
        await redis.quit().catch(() => {});
        throw error;
      }
    }
    return this.redis;
  }

  /**
   * Register a component to be managed by the harness
   */
  registerComponent(component: TestComponent): void {
    this.components.push(component);
  }

  /**
   * Register cleanup callback
   */
  onCleanup(callback: () => Promise<void>): void {
    this.cleanupCallbacks.push(callback);
  }

  /**
   * Start all registered components
   */
  async startAll(): Promise<void> {
    for (const component of this.components) {
      await component.start();
    }
  }

  /**
   * Stop all components and cleanup
   */
  async stopAll(): Promise<void> {
    // Stop components in reverse order
    for (const component of [...this.components].reverse()) {
      try {
        await component.stop();
      } catch (error) {
        console.warn('Error stopping component:', error);
      }
    }
    this.components = [];

    // Run cleanup callbacks
    for (const callback of this.cleanupCallbacks) {
      try {
        await callback();
      } catch (error) {
        console.warn('Error in cleanup callback:', error);
      }
    }
    this.cleanupCallbacks = [];

    // Close Redis connection
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  /**
   * Flush all Redis data (for test isolation)
   */
  async flushRedis(): Promise<void> {
    const redis = await this.getRedis();
    await redis.flushall();
  }
}
