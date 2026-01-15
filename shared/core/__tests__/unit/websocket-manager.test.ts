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
    it('should initialize with primary URL only when no fallbacks provided', () => {
      const config: WebSocketConfig = {
        url: 'wss://primary.example.com',
      };

      manager = new WebSocketManager(config);
      const stats = manager.getConnectionStats();

      expect(stats.totalUrls).toBe(1);
      expect(stats.currentUrlIndex).toBe(0);
      expect(manager.getCurrentUrl()).toBe('wss://primary.example.com');
    });

    it('should initialize with primary and fallback URLs', () => {
      const config: WebSocketConfig = {
        url: 'wss://primary.example.com',
        fallbackUrls: [
          'wss://fallback1.example.com',
          'wss://fallback2.example.com',
        ],
      };

      manager = new WebSocketManager(config);
      const stats = manager.getConnectionStats();

      expect(stats.totalUrls).toBe(3);
      expect(stats.currentUrlIndex).toBe(0);
      expect(manager.getCurrentUrl()).toBe('wss://primary.example.com');
    });

    it('should initialize with Optimism-style fallback configuration', () => {
      // Simulates the actual Optimism configuration from S2.1.4
      const config: WebSocketConfig = {
        url: 'wss://opt-mainnet.g.alchemy.com/v2/test-key',
        fallbackUrls: [
          'wss://mainnet.optimism.io',
          'wss://optimism.publicnode.com',
          'wss://optimism-mainnet.public.blastapi.io',
        ],
      };

      manager = new WebSocketManager(config);
      const stats = manager.getConnectionStats();

      expect(stats.totalUrls).toBe(4);
      expect(manager.getCurrentUrl()).toBe('wss://opt-mainnet.g.alchemy.com/v2/test-key');
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
    it('should use default reconnectInterval when not specified', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
      // Default is 5000ms - we verify the manager is created without errors
      expect(manager).toBeDefined();
    });

    it('should use default maxReconnectAttempts when not specified', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
      // Default is 10 - we verify the manager is created without errors
      expect(manager).toBeDefined();
    });

    it('should use default connectionTimeout when not specified', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
      // Default is 10000ms - we verify the manager is created without errors
      expect(manager).toBeDefined();
    });

    it('should allow custom configuration values', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        reconnectInterval: 3000,
        maxReconnectAttempts: 5,
        heartbeatInterval: 20000,
        connectionTimeout: 5000,
      };

      manager = new WebSocketManager(config);
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
    it('should allow registering message handlers', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
      const handler = jest.fn();

      const unsubscribe = manager.onMessage(handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should allow registering connection change handlers', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
      const handler = jest.fn();

      const unsubscribe = manager.onConnectionChange(handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should allow unsubscribing from message events', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
      const handler = jest.fn();

      const unsubscribe = manager.onMessage(handler);
      unsubscribe();

      // Handler should be removed - no way to directly verify,
      // but we ensure it doesn't throw
      expect(() => unsubscribe()).not.toThrow();
    });

    it('should support on() method for various events', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);

      const messageUnsubscribe = manager.on('message', () => {});
      const errorUnsubscribe = manager.on('error', () => {});
      const connectedUnsubscribe = manager.on('connected', () => {});
      const disconnectedUnsubscribe = manager.on('disconnected', () => {});
      const customUnsubscribe = manager.on('custom', () => {});

      expect(typeof messageUnsubscribe).toBe('function');
      expect(typeof errorUnsubscribe).toBe('function');
      expect(typeof connectedUnsubscribe).toBe('function');
      expect(typeof disconnectedUnsubscribe).toBe('function');
      expect(typeof customUnsubscribe).toBe('function');
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
    it('should return base delay for attempt 0', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        reconnectInterval: 1000,
        backoffMultiplier: 2.0,
        maxReconnectDelay: 60000,
        jitterPercent: 0, // Disable jitter for deterministic testing
      };

      manager = new WebSocketManager(config);

      const delay = manager.calculateReconnectDelay(0);
      // 1000 * 2^0 = 1000ms (no jitter)
      expect(delay).toBe(1000);
    });

    it('should apply exponential multiplier correctly', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        reconnectInterval: 1000,
        backoffMultiplier: 2.0,
        maxReconnectDelay: 60000,
        jitterPercent: 0,
      };

      manager = new WebSocketManager(config);

      // 1000 * 2^0 = 1000
      expect(manager.calculateReconnectDelay(0)).toBe(1000);
      // 1000 * 2^1 = 2000
      expect(manager.calculateReconnectDelay(1)).toBe(2000);
      // 1000 * 2^2 = 4000
      expect(manager.calculateReconnectDelay(2)).toBe(4000);
      // 1000 * 2^3 = 8000
      expect(manager.calculateReconnectDelay(3)).toBe(8000);
      // 1000 * 2^4 = 16000
      expect(manager.calculateReconnectDelay(4)).toBe(16000);
    });

    it('should cap delay at maxReconnectDelay', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        reconnectInterval: 1000,
        backoffMultiplier: 2.0,
        maxReconnectDelay: 5000,
        jitterPercent: 0,
      };

      manager = new WebSocketManager(config);

      // 1000 * 2^3 = 8000, but max is 5000
      expect(manager.calculateReconnectDelay(3)).toBe(5000);
      // 1000 * 2^10 = 1024000, but max is 5000
      expect(manager.calculateReconnectDelay(10)).toBe(5000);
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

    it('should handle custom multiplier', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        reconnectInterval: 1000,
        backoffMultiplier: 1.5,
        maxReconnectDelay: 60000,
        jitterPercent: 0,
      };

      manager = new WebSocketManager(config);

      // 1000 * 1.5^0 = 1000
      expect(manager.calculateReconnectDelay(0)).toBe(1000);
      // 1000 * 1.5^1 = 1500
      expect(manager.calculateReconnectDelay(1)).toBe(1500);
      // 1000 * 1.5^2 = 2250
      expect(manager.calculateReconnectDelay(2)).toBe(2250);
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
    it('should accept chainId configuration', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
        chainId: 'arbitrum',
      };

      manager = new WebSocketManager(config);
      // Should not throw
      expect(manager).toBeDefined();
    });

    it('should use default chainId when not specified', () => {
      const config: WebSocketConfig = {
        url: 'wss://test.example.com',
      };

      manager = new WebSocketManager(config);
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

    it('should detect JSON-RPC error code -32005 (Infura/Alchemy rate limit)', () => {
      const error = { code: -32005, message: 'Limit exceeded' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect JSON-RPC error code -32016 (rate limit)', () => {
      const error = { code: -32016, message: 'Rate limit' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect WebSocket close code 1008 (policy violation)', () => {
      const error = { code: 1008, message: 'Policy violation' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect WebSocket close code 1013 (try again later)', () => {
      const error = { code: 1013, message: 'Try again' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect HTTP status code 429', () => {
      const error = { code: 429, message: 'Too many requests' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect "rate limit" in error message', () => {
      const error = { message: 'Request rate limit exceeded' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect "too many requests" in error message', () => {
      const error = { message: 'Too many requests from your IP' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect "quota exceeded" in error message', () => {
      const error = { message: 'Daily quota exceeded for this API key' };
      expect(manager.isRateLimitError(error)).toBe(true);
    });

    it('should detect "throttled" in error message', () => {
      const error = { message: 'Request throttled' };
      expect(manager.isRateLimitError(error)).toBe(true);
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

    it('should handle case-insensitive matching', () => {
      const error = { message: 'RATE LIMIT EXCEEDED' };
      expect(manager.isRateLimitError(error)).toBe(true);
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
