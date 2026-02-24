/**
 * Redis Module
 *
 * Redis client, streams, distributed locking, and shared utilities:
 * - RedisClient: Core Redis connection and operations
 * - RedisStreamsClient: Event-driven streams with consumer groups (ADR-002)
 * - DistributedLockManager: Atomic distributed locking (ADR-007)
 * - resolveRedisPassword: Shared password resolution utility
 *
 * @module redis
 */

export * from './client';
export * from './streams';
export * from './stream-consumer';
export * from './distributed-lock';
export * from './utils';
