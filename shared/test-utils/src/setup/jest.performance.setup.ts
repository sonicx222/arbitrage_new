/**
 * Jest Setup for Performance Tests
 * Sets timeout to 300 seconds (performance tests can be slow)
 */
import '@jest/globals';

jest.setTimeout(300000);  // 5 minutes
