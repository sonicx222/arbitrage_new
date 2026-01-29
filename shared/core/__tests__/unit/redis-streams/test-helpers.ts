/**
 * Redis Streams Test Helpers
 *
 * Shared mock utilities for Redis Streams tests.
 * Extracted to reduce duplication across split test files.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { RedisStreamsConstructor } from '@arbitrage/core';

/**
 * Creates a mock Redis instance with all required methods for RedisStreamsClient.
 */
export function createMockRedisInstance() {
  const emitter = new EventEmitter();
  const instance: any = {};

  // Event methods
  instance.on = jest.fn((event: string, handler: (...args: any[]) => void) => {
    emitter.on(event, handler);
    return instance;
  });
  instance.removeAllListeners = jest.fn((event?: string) => {
    if (event) {
      emitter.removeAllListeners(event);
    } else {
      emitter.removeAllListeners();
    }
    return instance;
  });
  instance.emit = jest.fn((event: string, ...args: any[]) => {
    return emitter.emit(event, ...args);
  });

  // Stream operations
  instance.xadd = jest.fn();
  instance.xread = jest.fn();
  instance.xreadgroup = jest.fn();
  instance.xack = jest.fn();
  instance.xgroup = jest.fn();
  instance.xinfo = jest.fn();
  instance.xlen = jest.fn();
  instance.xtrim = jest.fn();
  instance.xpending = jest.fn();
  instance.xclaim = jest.fn();
  instance.ping = jest.fn(() => Promise.resolve('PONG'));
  instance.disconnect = jest.fn(() => Promise.resolve(undefined));
  instance.connect = jest.fn(() => Promise.resolve());

  return instance;
}

/**
 * Creates a mock Redis constructor for DI.
 */
export function createMockRedisConstructor() {
  let mockInstance: any = null;

  const MockRedis = jest.fn(() => {
    mockInstance = createMockRedisInstance();
    return mockInstance;
  }) as unknown as RedisStreamsConstructor;

  return { MockRedis, getMockInstance: () => mockInstance };
}

/**
 * Helper to create a mock handler that matches StreamConsumerConfig.handler signature.
 */
export const createMockHandler = (): any => jest.fn();
