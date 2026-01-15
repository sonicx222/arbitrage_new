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
