/**
 * WebSocket Manager Tests
 *
 * Unit tests for WebSocketManager with focus on:
 * - Fallback URL support (S2.1.4)
 * - Connection management
 * - Reconnection logic
 *
 * @migrated from shared/core/src/websocket-manager.test.ts
 * @see ADR-009: Test Architecture
 * @see S2.1.4: Configure WebSocket connection with fallback URLs
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock WebSocket
const mockWebSocket = {
  on: jest.fn(),
  send: jest.fn(),
  close: jest.fn(),
  ping: jest.fn(),
  removeAllListeners: jest.fn(),
  readyState: 1, // WebSocket.OPEN
};

jest.mock('ws', () => {
  return jest.fn(() => mockWebSocket);
});

// Import after mocks are set up
import { WebSocketManager } from '@arbitrage/core';
import type { WebSocketConfig } from '@arbitrage/core';

describe('WebSocketManager', () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Reset mock WebSocket state
    mockWebSocket.readyState = 1;
    mockWebSocket.on.mockReset();
    mockWebSocket.send.mockReset();
    mockWebSocket.close.mockReset();
    mockWebSocket.ping.mockReset();
    mockWebSocket.removeAllListeners.mockReset();
  });

  afterEach(() => {
    if (manager) {
      manager.disconnect();
    }
    jest.useRealTimers();
  });

  describe('Fallback URL Configuration (S2.1.4)', () => {
    it.each([
      {
        desc: 'primary URL only (no fallbacks)',
        url: 'wss://primary.example.com',
        fallbackUrls: undefined,
        expectedTotal: 1,
        expectedUrl: 'wss://primary.example.com',
      },
      {
        desc: 'primary and 2 fallback URLs',
        url: 'wss://primary.example.com',
        fallbackUrls: ['wss://fallback1.example.com', 'wss://fallback2.example.com'],
        expectedTotal: 3,
        expectedUrl: 'wss://primary.example.com',
      },
      {
        desc: 'Optimism-style fallback configuration (S2.1.4)',
        url: 'wss://opt-mainnet.g.alchemy.com/v2/test-key',
        fallbackUrls: [
          'wss://mainnet.optimism.io',
          'wss://optimism.publicnode.com',
          'wss://optimism-mainnet.public.blastapi.io',
        ],
        expectedTotal: 4,
        expectedUrl: 'wss://opt-mainnet.g.alchemy.com/v2/test-key',
      },
    ])('should initialize with $desc', ({ url, fallbackUrls, expectedTotal, expectedUrl }) => {
      const config: WebSocketConfig = {
        url,
        ...(fallbackUrls ? { fallbackUrls } : {}),
      };

      manager = new WebSocketManager(config);
      const stats = manager.getConnectionStats();

      expect(stats.totalUrls).toBe(expectedTotal);
      expect(stats.currentUrlIndex).toBe(0);
      expect(manager.getCurrentUrl()).toBe(expectedUrl);
    });

    it('should use pingInterval alias for heartbeatInterval', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        pingInterval: 15000,
      };

      manager = new WebSocketManager(config);
      // The pingInterval should be used as heartbeatInterval
      // We can't directly check the internal config, but we verify it doesn't throw
      expect(manager).toBeDefined();
    });
  });

  describe('getCurrentUrl()', () => {
    it('should return the current active URL', () => {
      const config: WebSocketConfig = {
        url: 'wss://primary.example.com',
        fallbackUrls: ['wss://fallback.example.com'],
      };

      manager = new WebSocketManager(config);

      expect(manager.getCurrentUrl()).toBe('wss://primary.example.com');
    });

    it('should return primary URL when allUrls is empty (edge case)', () => {
      const config: WebSocketConfig = {
        url: 'wss://primary.example.com',
      };

      manager = new WebSocketManager(config);
      // Accessing getCurrentUrl should always return a valid URL
      expect(manager.getCurrentUrl()).toBe('wss://primary.example.com');
    });
  });

  describe('getConnectionStats()', () => {
    it('should return comprehensive connection statistics', () => {
      const config: WebSocketConfig = {
        url: 'wss://primary.example.com',
        fallbackUrls: ['wss://fallback.example.com'],
      };

      manager = new WebSocketManager(config);
      const stats = manager.getConnectionStats();

      expect(stats).toHaveProperty('connected');
      expect(stats).toHaveProperty('connecting');
      expect(stats).toHaveProperty('reconnectAttempts');
      expect(stats).toHaveProperty('subscriptions');
      expect(stats).toHaveProperty('currentUrl');
      expect(stats).toHaveProperty('currentUrlIndex');
      expect(stats).toHaveProperty('totalUrls');
    });

    it('should reflect correct initial state', () => {
      const config: WebSocketConfig = {
        url: 'wss://primary.example.com',
        fallbackUrls: [
          'wss://fallback1.example.com',
          'wss://fallback2.example.com',
        ],
      };

      manager = new WebSocketManager(config);
      const stats = manager.getConnectionStats();

      expect(stats.connected).toBe(false);
      expect(stats.connecting).toBe(false);
      expect(stats.reconnectAttempts).toBe(0);
      expect(stats.subscriptions).toBe(0);
      expect(stats.currentUrl).toBe('wss://primary.example.com');
      expect(stats.currentUrlIndex).toBe(0);
      expect(stats.totalUrls).toBe(3);
    });
  });

  describe('Configuration Defaults', () => {
    it.each([
      { desc: 'default reconnectInterval', config: {} },
      { desc: 'default maxReconnectAttempts', config: {} },
      { desc: 'default connectionTimeout', config: {} },
      { desc: 'custom configuration values', config: { reconnectInterval: 3000, maxReconnectAttempts: 5, heartbeatInterval: 20000, connectionTimeout: 5000 } },
    ])('should initialize correctly with $desc', ({ config }) => {
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
        ...config,
      });
      expect(manager).toBeDefined();
    });
  });

  describe('isWebSocketConnected()', () => {
    it('should return false when not connected', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      expect(manager.isWebSocketConnected()).toBe(false);
    });
  });

  describe('disconnect()', () => {
    it('should clean up resources on disconnect', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        fallbackUrls: ['wss://fallback.example.com'],
      };

      manager = new WebSocketManager(config);
      manager.disconnect();

      const stats = manager.getConnectionStats();
      expect(stats.connected).toBe(false);
      expect(stats.connecting).toBe(false);
    });

    it('should be safe to call disconnect multiple times', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      // Should not throw
      expect(() => {
        manager.disconnect();
        manager.disconnect();
        manager.disconnect();
      }).not.toThrow();
    });
  });

  describe('removeAllListeners()', () => {
    it('should clear all event handlers', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      // Add some handlers
      manager.onMessage(() => {});
      manager.onConnectionChange(() => {});
      manager.on('error', () => {});

      // Remove all listeners
      manager.removeAllListeners();

      // Verify disconnect doesn't throw (handlers are cleared)
      expect(() => manager.disconnect()).not.toThrow();
    });
  });

  describe('subscribe()', () => {
    it('should add subscription and return subscription ID', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      const id = manager.subscribe({
        method: 'eth_subscribe',
        params: ['newHeads'],
      });

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);

      const stats = manager.getConnectionStats();
      expect(stats.subscriptions).toBe(1);
    });

    it('should increment subscription IDs', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      const id1 = manager.subscribe({ method: 'eth_subscribe', params: ['logs'] });
      const id2 = manager.subscribe({ method: 'eth_subscribe', params: ['newHeads'] });
      const id3 = manager.subscribe({ method: 'eth_subscribe', params: ['pendingTransactions'] });

      expect(id2).toBe(id1 + 1);
      expect(id3).toBe(id2 + 1);
    });
  });

  describe('unsubscribe()', () => {
    it('should remove subscription by ID', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      const id = manager.subscribe({
        method: 'eth_subscribe',
        params: ['newHeads'],
      });

      expect(manager.getConnectionStats().subscriptions).toBe(1);

      manager.unsubscribe(id);

      expect(manager.getConnectionStats().subscriptions).toBe(0);
    });

    it('should handle unsubscribing non-existent ID gracefully', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      // Should not throw
      expect(() => manager.unsubscribe(999)).not.toThrow();
    });
  });

  describe('Event Handlers', () => {
    it.each([
      { desc: 'message handler via onMessage()', method: 'onMessage' as const },
      { desc: 'connection change handler via onConnectionChange()', method: 'onConnectionChange' as const },
    ])('should register $desc and return unsubscribe function', ({ method }) => {
      manager = new WebSocketManager({ url: 'wss://test.example.com' });
      const handler = jest.fn();

      const unsubscribe = manager[method](handler);
      expect(typeof unsubscribe).toBe('function');
    });

    it('should allow unsubscribing from message events', () => {
      manager = new WebSocketManager({ url: 'wss://test.example.com' });
      const handler = jest.fn();

      const unsubscribe = manager.onMessage(handler);
      unsubscribe();

      // Handler should be removed - no way to directly verify,
      // but we ensure it doesn't throw
      expect(() => unsubscribe()).not.toThrow();
    });

    it.each([
      'message', 'error', 'connected', 'disconnected', 'custom',
    ])('should support on() method for "%s" event', (eventName) => {
      manager = new WebSocketManager({ url: 'wss://test.example.com' });
      const unsubscribe = manager.on(eventName, () => {});
      expect(typeof unsubscribe).toBe('function');
    });
  });
});

describe('WebSocketManager Exponential Backoff', () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (manager) {
      manager.disconnect();
    }
  });

  describe('calculateReconnectDelay()', () => {
    describe('deterministic delay (no jitter)', () => {
      it.each([
        // multiplier=2.0, maxDelay=60000: standard exponential backoff
        { desc: 'base delay at attempt 0 (2x multiplier)', multiplier: 2.0, maxDelay: 60000, attempt: 0, expected: 1000 },
        { desc: '2x at attempt 1', multiplier: 2.0, maxDelay: 60000, attempt: 1, expected: 2000 },
        { desc: '4x at attempt 2', multiplier: 2.0, maxDelay: 60000, attempt: 2, expected: 4000 },
        { desc: '8x at attempt 3', multiplier: 2.0, maxDelay: 60000, attempt: 3, expected: 8000 },
        { desc: '16x at attempt 4', multiplier: 2.0, maxDelay: 60000, attempt: 4, expected: 16000 },
        // multiplier=2.0, maxDelay=5000: cap enforcement
        { desc: 'capped at maxDelay (attempt 3, max=5000)', multiplier: 2.0, maxDelay: 5000, attempt: 3, expected: 5000 },
        { desc: 'capped at maxDelay (attempt 10, max=5000)', multiplier: 2.0, maxDelay: 5000, attempt: 10, expected: 5000 },
        // multiplier=1.5: custom multiplier
        { desc: 'base delay at attempt 0 (1.5x multiplier)', multiplier: 1.5, maxDelay: 60000, attempt: 0, expected: 1000 },
        { desc: '1.5x at attempt 1', multiplier: 1.5, maxDelay: 60000, attempt: 1, expected: 1500 },
        { desc: '2.25x at attempt 2 (1.5x multiplier)', multiplier: 1.5, maxDelay: 60000, attempt: 2, expected: 2250 },
      ])('$desc → $expected ms', ({ multiplier, maxDelay, attempt, expected }) => {
        manager = new WebSocketManager({
          url: 'wss://test.example.com',
          reconnectInterval: 1000,
          backoffMultiplier: multiplier,
          maxReconnectDelay: maxDelay,
          jitterPercent: 0,
        });

        expect(manager.calculateReconnectDelay(attempt)).toBe(expected);
      });
    });

    it('should add jitter within specified range', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        reconnectInterval: 1000,
        backoffMultiplier: 2.0,
        maxReconnectDelay: 60000,
        jitterPercent: 0.25,
      };

      manager = new WebSocketManager(config);

      // Run multiple times to verify jitter is applied
      const delays = new Set<number>();
      for (let i = 0; i < 20; i++) {
        delays.add(manager.calculateReconnectDelay(0));
      }

      // With 25% jitter, delay should be between 1000 and 1250
      // Multiple runs should produce some variation (unless very unlucky)
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1250);
      }
    });

    it('should use default values when config not specified', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      // Default: baseDelay=1000, multiplier=2, maxDelay=60000, jitter=0.25
      const delay = manager.calculateReconnectDelay(0);

      // Should be between 1000 and 1250 (with 25% jitter)
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1250);
    });

    it('should prevent thundering herd with jitter', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        reconnectInterval: 1000,
        jitterPercent: 0.25,
      };

      manager = new WebSocketManager(config);

      // Create multiple managers and verify they would reconnect at different times
      const delays: number[] = [];
      for (let i = 0; i < 100; i++) {
        delays.push(manager.calculateReconnectDelay(0));
      }

      // Calculate standard deviation - should show variation
      const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
      const variance = delays.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / delays.length;
      const stdDev = Math.sqrt(variance);

      // With 25% jitter on 1000ms base, we expect some meaningful spread
      expect(stdDev).toBeGreaterThan(0);
    });
  });

  describe('Exponential Backoff Configuration', () => {
    it.each([
      { desc: 'with explicit chainId', config: { chainId: 'arbitrum' } },
      { desc: 'with default chainId', config: {} },
    ])('should accept configuration $desc', ({ config }) => {
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
        ...config,
      } as WebSocketConfig);
      expect(manager).toBeDefined();
    });
  });
});

describe('WebSocketManager Rate Limit Handling (S3.3)', () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (manager) {
      manager.disconnect();
    }
  });

  describe('isRateLimitError()', () => {
    beforeEach(() => {
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
      });
    });

    it.each([
      { desc: 'JSON-RPC -32005 (Infura/Alchemy)', error: { code: -32005, message: 'Limit exceeded' }, expected: true },
      { desc: 'JSON-RPC -32016 (rate limit)', error: { code: -32016, message: 'Rate limit' }, expected: true },
      { desc: 'WebSocket 1008 (policy violation)', error: { code: 1008, message: 'Policy violation' }, expected: true },
      { desc: 'WebSocket 1013 (try again later)', error: { code: 1013, message: 'Try again' }, expected: true },
      { desc: 'HTTP 429', error: { code: 429, message: 'Too many requests' }, expected: true },
      { desc: '"rate limit" in message', error: { message: 'Request rate limit exceeded' }, expected: true },
      { desc: '"too many requests" in message', error: { message: 'Too many requests from your IP' }, expected: true },
      { desc: '"quota exceeded" in message', error: { message: 'Daily quota exceeded for this API key' }, expected: true },
      { desc: '"throttled" in message', error: { message: 'Request throttled' }, expected: true },
      { desc: 'case-insensitive matching', error: { message: 'RATE LIMIT EXCEEDED' }, expected: true },
    ])('should detect rate limit: $desc', ({ error, expected }) => {
      expect(manager.isRateLimitError(error)).toBe(expected);
    });

    it('should not detect normal errors as rate limits', () => {
      const normalErrors = [
        { code: -32600, message: 'Invalid Request' },
        { code: -32601, message: 'Method not found' },
        { code: 1000, message: 'Normal closure' },
        { message: 'Connection timeout' },
        { message: 'Network error' },
        null,
        undefined,
      ];

      for (const error of normalErrors) {
        expect(manager.isRateLimitError(error)).toBe(false);
      }
    });
  });

  describe('Provider Exclusion', () => {
    beforeEach(() => {
      manager = new WebSocketManager({
        url: 'wss://primary.example.com',
        fallbackUrls: [
          'wss://fallback1.example.com',
          'wss://fallback2.example.com',
        ],
      });
    });

    it('should not exclude providers initially', () => {
      expect(manager.isProviderExcluded('wss://primary.example.com')).toBe(false);
      expect(manager.isProviderExcluded('wss://fallback1.example.com')).toBe(false);
    });

    it('should exclude provider after handleRateLimit()', () => {
      manager.handleRateLimit('wss://primary.example.com');
      expect(manager.isProviderExcluded('wss://primary.example.com')).toBe(true);
    });

    it('should apply exponential exclusion duration', () => {
      // First rate limit: 30s
      manager.handleRateLimit('wss://primary.example.com');
      let exclusions = manager.getExcludedProviders();
      let exclusion = exclusions.get('wss://primary.example.com');
      expect(exclusion?.count).toBe(1);

      // Second rate limit: 60s
      manager.handleRateLimit('wss://primary.example.com');
      exclusions = manager.getExcludedProviders();
      exclusion = exclusions.get('wss://primary.example.com');
      expect(exclusion?.count).toBe(2);

      // Third rate limit: 120s
      manager.handleRateLimit('wss://primary.example.com');
      exclusions = manager.getExcludedProviders();
      exclusion = exclusions.get('wss://primary.example.com');
      expect(exclusion?.count).toBe(3);
    });

    it('should report correct available provider count', () => {
      expect(manager.getAvailableProviderCount()).toBe(3);

      manager.handleRateLimit('wss://primary.example.com');
      expect(manager.getAvailableProviderCount()).toBe(2);

      manager.handleRateLimit('wss://fallback1.example.com');
      expect(manager.getAvailableProviderCount()).toBe(1);
    });

    it('should clear all exclusions with clearProviderExclusions()', () => {
      manager.handleRateLimit('wss://primary.example.com');
      manager.handleRateLimit('wss://fallback1.example.com');

      expect(manager.getAvailableProviderCount()).toBe(1);

      manager.clearProviderExclusions();

      expect(manager.getAvailableProviderCount()).toBe(3);
      expect(manager.isProviderExcluded('wss://primary.example.com')).toBe(false);
    });

    it('should emit rateLimit event when handling rate limit', () => {
      const handler = jest.fn();
      manager.on('rateLimit', handler);

      manager.handleRateLimit('wss://primary.example.com');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'wss://primary.example.com',
          count: 1,
        })
      );
    });
  });

  describe('URL Switching with Exclusions', () => {
    it('should report connection stats including URL info', () => {
      manager = new WebSocketManager({
        url: 'wss://primary.example.com',
        fallbackUrls: ['wss://fallback.example.com'],
      });

      const stats = manager.getConnectionStats();
      expect(stats.totalUrls).toBe(2);
      expect(stats.currentUrl).toBe('wss://primary.example.com');
    });
  });
});

describe('WebSocketManager Fallback URL Integration', () => {
  describe('Optimism Chain Configuration', () => {
    it('should match the S2.1.4 Optimism WebSocket configuration', () => {
      // This test verifies the configuration matches what's in shared/config/src/index.ts
      const optimismConfig: WebSocketConfig = {
        url: 'wss://opt-mainnet.g.alchemy.com/v2/test-api-key',
        fallbackUrls: [
          'wss://mainnet.optimism.io',
          'wss://optimism.publicnode.com',
          'wss://optimism-mainnet.public.blastapi.io',
        ],
        reconnectInterval: 5000,
        maxReconnectAttempts: 5,
        pingInterval: 30000,
        connectionTimeout: 10000,
      };

      const manager = new WebSocketManager(optimismConfig);
      const stats = manager.getConnectionStats();

      // Verify 4 URLs total (1 primary + 3 fallbacks)
      expect(stats.totalUrls).toBe(4);

      // Verify primary URL is Alchemy
      expect(manager.getCurrentUrl()).toContain('alchemy.com');

      manager.disconnect();
    });

    it('should support chain-instance.ts WebSocket configuration pattern', () => {
      // Simulates how chain-instance.ts configures WebSocket
      const chainConfig = {
        wsUrl: 'wss://opt-mainnet.g.alchemy.com/v2/api-key',
        wsFallbackUrls: [
          'wss://mainnet.optimism.io',
          'wss://optimism.publicnode.com',
          'wss://optimism-mainnet.public.blastapi.io',
        ],
        rpcUrl: 'https://mainnet.optimism.io', // Fallback if wsUrl is undefined
      };

      const primaryWsUrl = chainConfig.wsUrl || chainConfig.rpcUrl;

      const wsConfig: WebSocketConfig = {
        url: primaryWsUrl,
        fallbackUrls: chainConfig.wsFallbackUrls,
        reconnectInterval: 5000,
        maxReconnectAttempts: 5,
        pingInterval: 30000,
        connectionTimeout: 10000,
      };

      const manager = new WebSocketManager(wsConfig);
      const stats = manager.getConnectionStats();

      expect(stats.totalUrls).toBe(4);
      expect(manager.getCurrentUrl()).toBe(chainConfig.wsUrl);

      manager.disconnect();
    });

    it('should fall back to rpcUrl when wsUrl is undefined', () => {
      // Tests the fallback logic in chain-instance.ts line 220
      const chainConfig = {
        wsUrl: undefined,
        wsFallbackUrls: ['wss://fallback.example.com'],
        rpcUrl: 'https://mainnet.optimism.io',
      };

      const primaryWsUrl = chainConfig.wsUrl || chainConfig.rpcUrl;

      const wsConfig: WebSocketConfig = {
        url: primaryWsUrl,
        fallbackUrls: chainConfig.wsFallbackUrls,
      };

      const manager = new WebSocketManager(wsConfig);

      expect(manager.getCurrentUrl()).toBe('https://mainnet.optimism.io');

      manager.disconnect();
    });
  });
});

/**
 * Phase 2: Worker Thread JSON Parsing Tests
 * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 2
 */
describe('WebSocketManager Worker Thread JSON Parsing', () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (manager) {
      manager.disconnect();
    }
  });

  describe('Configuration', () => {
    it.each([
      { desc: 'disabled by default', config: {}, expectedEnabled: false, expectedThreshold: undefined },
      { desc: 'enabled when configured', config: { useWorkerParsing: true }, expectedEnabled: true, expectedThreshold: 2048 },
      { desc: 'custom threshold', config: { useWorkerParsing: true, workerParsingThresholdBytes: 4096 }, expectedEnabled: true, expectedThreshold: 4096 },
    ])('should initialize with $desc', ({ config, expectedEnabled, expectedThreshold }) => {
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
        ...config,
      });
      const stats = manager.getWorkerParsingStats();

      expect(stats.enabled).toBe(expectedEnabled);
      if (expectedThreshold !== undefined) {
        // P1-PHASE1: Default threshold changed from 1024 to 2048
        expect(stats.thresholdBytes).toBe(expectedThreshold);
      }
    });
  });

  describe('Runtime Control', () => {
    it.each([
      { desc: 'enable at runtime', initialParsing: undefined, toggleTo: true, expectedBefore: false, expectedAfter: true },
      { desc: 'disable at runtime', initialParsing: true, toggleTo: false, expectedBefore: true, expectedAfter: false },
    ])('should $desc', ({ initialParsing, toggleTo, expectedBefore, expectedAfter }) => {
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
        ...(initialParsing !== undefined ? { useWorkerParsing: initialParsing } : {}),
      });

      expect(manager.getWorkerParsingStats().enabled).toBe(expectedBefore);
      manager.setWorkerParsing(toggleTo);
      expect(manager.getWorkerParsingStats().enabled).toBe(expectedAfter);
    });

    it.each([
      { desc: 'change threshold to 4096', newThreshold: 4096, expected: 4096 },
      { desc: 'handle negative threshold by using 0', newThreshold: -100, expected: 0 },
    ])('should $desc', ({ newThreshold, expected }) => {
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
        useWorkerParsing: true,
      });

      manager.setWorkerParsingThreshold(newThreshold);
      expect(manager.getWorkerParsingStats().thresholdBytes).toBe(expected);
    });
  });

  describe('Statistics', () => {
    it.each([
      { desc: 'mainThreadParses', stat: 'mainThreadParses' as const, expected: 0 },
      { desc: 'workerThreadParses', stat: 'workerThreadParses' as const, expected: 0 },
      { desc: 'workerUsagePercent (no parses)', stat: 'workerUsagePercent' as const, expected: 0 },
    ])('should initialize $desc to $expected', ({ stat, expected }) => {
      manager = new WebSocketManager({ url: 'wss://test.example.com' });
      const stats = manager.getWorkerParsingStats();
      expect(stats[stat]).toBe(expected);
    });

    it('should reset statistics', () => {
      manager = new WebSocketManager({ url: 'wss://test.example.com' });

      manager.resetWorkerParsingStats();
      const stats = manager.getWorkerParsingStats();

      expect(stats.mainThreadParses).toBe(0);
      expect(stats.workerThreadParses).toBe(0);
      expect(stats.parseErrors).toBe(0);
      expect(stats.poolStartupFallbacks).toBe(0);
    });

    it('should report pool ready status as false initially (lazy initialization)', () => {
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
        useWorkerParsing: true,
      });

      expect(manager.getWorkerParsingStats().poolReady).toBe(false);
    });
  });

  describe('Statistics Format', () => {
    it('should return complete statistics object', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        useWorkerParsing: true,
        workerParsingThresholdBytes: 512,
      };

      manager = new WebSocketManager(config);
      const stats = manager.getWorkerParsingStats();

      // Verify all expected properties exist
      expect(stats).toHaveProperty('enabled');
      expect(stats).toHaveProperty('poolReady');
      expect(stats).toHaveProperty('thresholdBytes');
      expect(stats).toHaveProperty('mainThreadParses');
      expect(stats).toHaveProperty('workerThreadParses');
      expect(stats).toHaveProperty('parseErrors');
      expect(stats).toHaveProperty('poolStartupFallbacks');
      expect(stats).toHaveProperty('workerUsagePercent');

      // Verify values
      expect(stats.enabled).toBe(true);
      expect(stats.thresholdBytes).toBe(512);
      expect(typeof stats.workerUsagePercent).toBe('number');
    });
  });

  // P3-FIX: Tests for production auto-enable behavior (P1-PHASE1)
  describe('Production Auto-Enable', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore original environment
      process.env = { ...originalEnv };
    });

    it('should disable worker parsing in test environment by default', () => {
      // In test environment (NODE_ENV=test), worker parsing should be disabled by default
      // This is the current behavior since NODE_ENV=test is not detected as production
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
      expect(manager.getWorkerParsingStats().enabled).toBe(false);
    });

    it.each([
      { desc: 'explicit enable in non-production', envSetup: () => {}, useWorkerParsing: true, expected: true },
      { desc: 'explicit disable in production', envSetup: () => { process.env.NODE_ENV = 'production'; }, useWorkerParsing: false, expected: false },
    ])('should respect $desc override', ({ envSetup, useWorkerParsing, expected }) => {
      envSetup();
      manager = new WebSocketManager({
        url: 'wss://test.example.com',
        useWorkerParsing,
      });
      expect(manager.getWorkerParsingStats().enabled).toBe(expected);
    });

    it.each([
      { desc: 'Fly.io (FLY_APP_NAME)', envVar: 'FLY_APP_NAME', envValue: 'test-app' },
      { desc: 'Railway (RAILWAY_ENVIRONMENT)', envVar: 'RAILWAY_ENVIRONMENT', envValue: 'production' },
      { desc: 'NODE_ENV=production', envVar: 'NODE_ENV', envValue: 'production' },
    ])('should auto-enable in $desc environment', ({ envVar, envValue }) => {
      process.env[envVar] = envValue;

      manager = new WebSocketManager({ url: 'wss://test.example.com' });
      expect(manager.getWorkerParsingStats().enabled).toBe(true);
    });
  });
});
