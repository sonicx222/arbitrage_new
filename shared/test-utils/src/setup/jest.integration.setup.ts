/**
 * Jest Setup for Integration Tests
 * Sets timeout to 60 seconds (allows for Redis/service startup)
 */
import '@jest/globals';

jest.setTimeout(60000);  // 60 seconds
