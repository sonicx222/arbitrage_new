/**
 * Tests for Redis Test Helper
 *
 * Tests for isolated Redis database functionality for test suites.
 *
 * @see Task 2.2: Test Isolation Improvements
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import after environment setup
let getIsolatedRedisDatabase: any;
let createIsolatedRedisClient: any;
let cleanupTestRedis: any;
let resetDatabaseCounter: any;

describe('RedisTestHelper', () => {
  beforeEach(() => {
    // Reset modules for clean state
    jest.resetModules();

    // Import fresh module
    const helper = require('../../src/redis-test-helper');
    getIsolatedRedisDatabase = helper.getIsolatedRedisDatabase;
    createIsolatedRedisClient = helper.createIsolatedRedisClient;
    cleanupTestRedis = helper.cleanupTestRedis;
    resetDatabaseCounter = helper.resetDatabaseCounter;

    // Reset state
    resetDatabaseCounter();
  });

  afterEach(() => {
    // Clean up
    resetDatabaseCounter();
  });

  describe('getIsolatedRedisDatabase', () => {
    it('should return a unique database number for each test suite', () => {
      const db1 = getIsolatedRedisDatabase('TestSuite1');
      const db2 = getIsolatedRedisDatabase('TestSuite2');
      const db3 = getIsolatedRedisDatabase('TestSuite3');

      expect(db1).not.toBe(db2);
      expect(db2).not.toBe(db3);
      expect(db1).not.toBe(db3);
    });

    it('should return the same database for the same test suite', () => {
      const db1a = getIsolatedRedisDatabase('TestSuite1');
      const db1b = getIsolatedRedisDatabase('TestSuite1');

      expect(db1a).toBe(db1b);
    });

    it('should start from database 1', () => {
      const db1 = getIsolatedRedisDatabase('FirstSuite');

      expect(db1).toBe(1);
    });

    it('should increment database numbers sequentially', () => {
      const db1 = getIsolatedRedisDatabase('Suite1');
      const db2 = getIsolatedRedisDatabase('Suite2');
      const db3 = getIsolatedRedisDatabase('Suite3');

      expect(db2).toBe(db1 + 1);
      expect(db3).toBe(db2 + 1);
    });

    it('should handle many test suites (with wraparound)', () => {
      const databases = new Set<number>();

      // Request 10 unique suites (well under the 15 limit)
      for (let i = 0; i < 10; i++) {
        databases.add(getIsolatedRedisDatabase(`Suite${i}`));
      }

      // All 10 should be unique
      expect(databases.size).toBe(10);
    });

    it('should wrap around after reaching max databases', () => {
      // Fill up all 15 databases
      for (let i = 0; i < 15; i++) {
        getIsolatedRedisDatabase(`FillSuite${i}`);
      }

      // The next one should wrap around and start from 1
      const wrappedDb = getIsolatedRedisDatabase('WrappedSuite');
      expect(wrappedDb).toBe(1);
    });

    it('should handle empty test suite name', () => {
      const db = getIsolatedRedisDatabase('');

      expect(typeof db).toBe('number');
      expect(db).toBeGreaterThan(0);
    });
  });

  describe('createIsolatedRedisClient', () => {
    // Skip actual Redis connection tests in unit tests
    // These will be tested in integration tests

    it('should be a function', () => {
      expect(typeof createIsolatedRedisClient).toBe('function');
    });

    it('should accept a test suite name', () => {
      // Just verify the function signature
      expect(createIsolatedRedisClient.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('cleanupTestRedis', () => {
    it('should be a function', () => {
      expect(typeof cleanupTestRedis).toBe('function');
    });
  });

  describe('resetDatabaseCounter', () => {
    it('should reset the database counter', () => {
      getIsolatedRedisDatabase('Suite1');
      getIsolatedRedisDatabase('Suite2');

      resetDatabaseCounter();

      const db = getIsolatedRedisDatabase('NewSuite');
      expect(db).toBe(1);
    });

    it('should clear all suite mappings', () => {
      const db1 = getIsolatedRedisDatabase('Suite1');

      resetDatabaseCounter();

      const db1After = getIsolatedRedisDatabase('Suite1');

      // After reset, should get a new database number (starting from 1)
      expect(db1After).toBe(1);
    });
  });

  describe('isolation guarantee', () => {
    it('should ensure databases do not overlap', () => {
      const suites = ['UnitTests', 'IntegrationTests', 'E2ETests', 'PerformanceTests'];
      const databases = suites.map(suite => getIsolatedRedisDatabase(suite));

      // All databases should be unique
      const uniqueDatabases = new Set(databases);
      expect(uniqueDatabases.size).toBe(suites.length);

      // All should be within Redis database range (0-15 typically)
      databases.forEach(db => {
        expect(db).toBeGreaterThan(0);
        expect(db).toBeLessThanOrEqual(15);
      });
    });
  });
});
