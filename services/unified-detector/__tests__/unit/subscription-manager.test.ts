/**
 * SubscriptionManager Tests
 *
 * Tests for the extracted subscription management module.
 * Verifies WebSocket initialization, factory/legacy subscription modes,
 * rollout logic, and subscription statistics.
 *
 * @see subscription/subscription-manager.ts
 * @see Finding #8 in .agent-reports/unified-detector-deep-analysis.md
 */

// =============================================================================
// Mock Setup
// =============================================================================

const mockWsManagerInstance = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  removeAllListeners: jest.fn(),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

const mockFactoryServiceInstance = {
  onPairCreated: jest.fn(),
  subscribeToFactories: jest.fn().mockResolvedValue(undefined),
  getSubscriptionCount: jest.fn().mockReturnValue(3),
  stop: jest.fn().mockResolvedValue(undefined),
};

const MockWebSocketManager = jest.fn().mockImplementation(() => mockWsManagerInstance);
const MockFactorySubscriptionService = jest.fn().mockImplementation(() => mockFactoryServiceInstance);

jest.mock('@arbitrage/core', () => ({
  WebSocketManager: MockWebSocketManager,
  FactorySubscriptionService: MockFactorySubscriptionService,
}));

jest.mock('@arbitrage/config', () => ({
  EVENT_SIGNATURES: {
    SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
    SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  },
  getAllFactoryAddresses: jest.fn().mockReturnValue(['0xFactory1', '0xFactory2']),
}));

jest.mock('../../src/types', () => ({
  toWebSocketUrl: jest.fn((url: string) => {
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
      return { url, converted: false };
    }
    if (url.startsWith('http://')) {
      return { url: url.replace('http://', 'ws://'), converted: true, originalUrl: url };
    }
    if (url.startsWith('https://')) {
      return { url: url.replace('https://', 'wss://'), converted: true, originalUrl: url };
    }
    throw new Error(`Cannot convert URL: ${url}`);
  }),
  isUnstableChain: jest.fn().mockReturnValue(false),
}));

jest.mock('../../src/constants', () => ({
  UNSTABLE_WEBSOCKET_CHAINS: ['bsc', 'fantom'],
  DEFAULT_WS_CONNECTION_TIMEOUT_MS: 10000,
  EXTENDED_WS_CONNECTION_TIMEOUT_MS: 15000,
}));

import { SubscriptionManager, createSubscriptionManager } from '../../src/subscription/subscription-manager';
import type { SubscriptionManagerConfig, SubscriptionCallbacks } from '../../src/subscription/subscription-manager';
import { getAllFactoryAddresses } from '@arbitrage/config';
import { toWebSocketUrl, isUnstableChain } from '../../src/types';

// =============================================================================
// Fixtures
// =============================================================================

function createMockLogger() {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

function createDefaultConfig(overrides?: Partial<SubscriptionManagerConfig>): SubscriptionManagerConfig {
  return {
    chainId: 'ethereum',
    chainConfig: {
      wsUrl: 'wss://eth-mainnet.example.com',
      rpcUrl: 'https://eth-mainnet.example.com',
      wsFallbackUrls: ['wss://eth-fallback.example.com'],
    },
    subscriptionConfig: {
      useFactorySubscriptions: true,
      factorySubscriptionEnabledChains: ['ethereum', 'bsc', 'arbitrum'],
      factorySubscriptionRolloutPercent: 100,
    },
    maxReconnectAttempts: 5,
    logger: createMockLogger(),
    ...overrides,
  };
}

function createMockCallbacks(): SubscriptionCallbacks {
  return {
    onMessage: jest.fn(),
    onError: jest.fn(),
    onDisconnected: jest.fn(),
    onConnected: jest.fn(),
    onSyncEvent: jest.fn(),
    onSwapEvent: jest.fn(),
    onNewBlock: jest.fn(),
    onPairCreated: jest.fn(),
  };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  // Re-establish mocks after global jest.resetAllMocks()
  MockWebSocketManager.mockImplementation(() => mockWsManagerInstance);
  MockFactorySubscriptionService.mockImplementation(() => mockFactoryServiceInstance);
  mockWsManagerInstance.on.mockReturnValue(mockWsManagerInstance);
  mockWsManagerInstance.connect.mockResolvedValue(undefined);
  mockWsManagerInstance.subscribe.mockResolvedValue(undefined);
  mockFactoryServiceInstance.onPairCreated.mockReturnValue(undefined);
  mockFactoryServiceInstance.subscribeToFactories.mockResolvedValue(undefined);
  mockFactoryServiceInstance.getSubscriptionCount.mockReturnValue(3);

  (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xFactory1', '0xFactory2']);
  (toWebSocketUrl as jest.Mock).mockImplementation((url: string) => {
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
      return { url, converted: false };
    }
    if (url.startsWith('http://')) {
      return { url: url.replace('http://', 'ws://'), converted: true, originalUrl: url };
    }
    if (url.startsWith('https://')) {
      return { url: url.replace('https://', 'wss://'), converted: true, originalUrl: url };
    }
    throw new Error(`Cannot convert URL: ${url}`);
  });
  (isUnstableChain as jest.Mock).mockReturnValue(false);
});

// =============================================================================
// Tests
// =============================================================================

describe('SubscriptionManager', () => {
  describe('constructor', () => {
    it('should create an instance with config', () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      expect(manager).toBeInstanceOf(SubscriptionManager);
    });
  });

  describe('createSubscriptionManager', () => {
    it('should create an instance via factory function', () => {
      const config = createDefaultConfig();
      const manager = createSubscriptionManager(config);
      expect(manager).toBeInstanceOf(SubscriptionManager);
    });
  });

  describe('shouldUseFactorySubscriptions', () => {
    it('should return false when useFactorySubscriptions is disabled', () => {
      const config = createDefaultConfig({
        subscriptionConfig: {
          useFactorySubscriptions: false,
          factorySubscriptionEnabledChains: ['ethereum'],
          factorySubscriptionRolloutPercent: 100,
        },
      });
      const manager = new SubscriptionManager(config);

      expect(manager.shouldUseFactorySubscriptions()).toBe(false);
    });

    it('should return true when chain is in enabled chains list', () => {
      const config = createDefaultConfig({
        chainId: 'ethereum',
        subscriptionConfig: {
          useFactorySubscriptions: true,
          factorySubscriptionEnabledChains: ['ethereum', 'bsc'],
          factorySubscriptionRolloutPercent: 100,
        },
      });
      const manager = new SubscriptionManager(config);

      expect(manager.shouldUseFactorySubscriptions()).toBe(true);
    });

    it('should return false when chain is not in enabled chains list', () => {
      const config = createDefaultConfig({
        chainId: 'polygon',
        subscriptionConfig: {
          useFactorySubscriptions: true,
          factorySubscriptionEnabledChains: ['ethereum', 'bsc'],
          factorySubscriptionRolloutPercent: 100,
        },
      });
      const manager = new SubscriptionManager(config);

      expect(manager.shouldUseFactorySubscriptions()).toBe(false);
    });

    it('should use rollout percentage when chain list is empty', () => {
      const config = createDefaultConfig({
        chainId: 'ethereum',
        subscriptionConfig: {
          useFactorySubscriptions: true,
          factorySubscriptionEnabledChains: [],
          factorySubscriptionRolloutPercent: 50,
        },
      });
      const manager = new SubscriptionManager(config);

      // Result depends on hash of 'ethereum' % 100 vs 50
      const result = manager.shouldUseFactorySubscriptions();
      expect(typeof result).toBe('boolean');
    });

    it('should return true when rollout is 100% and no chain list', () => {
      const config = createDefaultConfig({
        subscriptionConfig: {
          useFactorySubscriptions: true,
          factorySubscriptionEnabledChains: [],
          factorySubscriptionRolloutPercent: 100,
        },
      });
      const manager = new SubscriptionManager(config);

      // With 100% rollout and empty chain list, should default to true
      expect(manager.shouldUseFactorySubscriptions()).toBe(true);
    });

    it('should return false when rollout is 0%', () => {
      const config = createDefaultConfig({
        subscriptionConfig: {
          useFactorySubscriptions: true,
          factorySubscriptionEnabledChains: [],
          factorySubscriptionRolloutPercent: 0,
        },
      });
      const manager = new SubscriptionManager(config);

      expect(manager.shouldUseFactorySubscriptions()).toBe(false);
    });
  });

  describe('hashChainName', () => {
    it('should return a deterministic value for the same input', () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);

      const hash1 = manager.hashChainName('ethereum');
      const hash2 = manager.hashChainName('ethereum');

      expect(hash1).toBe(hash2);
    });

    it('should return different values for different inputs', () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);

      const hash1 = manager.hashChainName('ethereum');
      const hash2 = manager.hashChainName('bsc');

      expect(hash1).not.toBe(hash2);
    });

    it('should return a non-negative number', () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);

      const hash = manager.hashChainName('ethereum');
      expect(hash).toBeGreaterThanOrEqual(0);
    });
  });

  describe('initialize', () => {
    it('should create WebSocketManager with correct config', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, ['0xpair1', '0xpair2']);

      expect(MockWebSocketManager).toHaveBeenCalledWith(expect.objectContaining({
        url: 'wss://eth-mainnet.example.com',
        maxReconnectAttempts: 5,
        chainId: 'ethereum',
      }));
    });

    it('should connect WebSocket manager', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      expect(mockWsManagerInstance.connect).toHaveBeenCalled();
    });

    it('should set up WebSocket event handlers', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      expect(mockWsManagerInstance.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWsManagerInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWsManagerInstance.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockWsManagerInstance.on).toHaveBeenCalledWith('connected', expect.any(Function));
    });

    it('should return wsManager and subscription result', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      const result = await manager.initialize(callbacks, ['0xpair1']);

      expect(result.wsManager).toBe(mockWsManagerInstance);
      expect(result.subscriptionStats).toBeDefined();
      expect(typeof result.useFactoryMode).toBe('boolean');
    });

    it('should convert HTTP RPC URL to WebSocket when wsUrl is missing', async () => {
      const config = createDefaultConfig({
        chainConfig: {
          wsUrl: undefined,
          rpcUrl: 'https://eth-rpc.example.com',
        },
      });
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      expect(toWebSocketUrl).toHaveBeenCalledWith('https://eth-rpc.example.com');
    });

    it('should throw when no valid WebSocket URL is available', async () => {
      (toWebSocketUrl as jest.Mock).mockImplementation(() => {
        throw new Error('Cannot convert URL');
      });

      const config = createDefaultConfig({
        chainConfig: {
          wsUrl: undefined,
          rpcUrl: 'ftp://invalid',
        },
      });
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await expect(manager.initialize(callbacks, [])).rejects.toThrow(
        /No valid WebSocket URL available/
      );
    });

    it('should use extended timeout for unstable chains', async () => {
      (isUnstableChain as jest.Mock).mockReturnValue(true);

      const config = createDefaultConfig({ chainId: 'bsc' });
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      expect(MockWebSocketManager).toHaveBeenCalledWith(expect.objectContaining({
        connectionTimeout: 15000,
      }));
    });

    it('should use default timeout for stable chains', async () => {
      (isUnstableChain as jest.Mock).mockReturnValue(false);

      const config = createDefaultConfig({ chainId: 'ethereum' });
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      expect(MockWebSocketManager).toHaveBeenCalledWith(expect.objectContaining({
        connectionTimeout: 10000,
      }));
    });

    it('should throw when WebSocket connect fails', async () => {
      mockWsManagerInstance.connect.mockRejectedValueOnce(new Error('Connection refused'));

      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await expect(manager.initialize(callbacks, [])).rejects.toThrow('Connection refused');
    });
  });

  describe('factory subscription mode', () => {
    it('should create FactorySubscriptionService in factory mode', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      const result = await manager.initialize(callbacks, ['0xpair1']);

      expect(MockFactorySubscriptionService).toHaveBeenCalled();
      expect(result.factorySubscriptionService).toBe(mockFactoryServiceInstance);
      expect(result.useFactoryMode).toBe(true);
    });

    it('should register onPairCreated callback', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, ['0xpair1']);

      expect(mockFactoryServiceInstance.onPairCreated).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should subscribe to factories', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, ['0xpair1']);

      expect(mockFactoryServiceInstance.subscribeToFactories).toHaveBeenCalled();
    });

    it('should subscribe to Sync/Swap/newHeads for existing pairs', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, ['0xpair1', '0xpair2']);

      // 3 subscriptions: Sync, Swap, newHeads
      expect(mockWsManagerInstance.subscribe).toHaveBeenCalledTimes(3);
    });

    it('should only subscribe to newHeads when no pair addresses', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      // Only 1 subscription: newHeads (no Sync/Swap without pairs)
      expect(mockWsManagerInstance.subscribe).toHaveBeenCalledTimes(1);
    });

    it('should set subscription stats for factory mode', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      const result = await manager.initialize(callbacks, ['0xpair1', '0xpair2']);

      expect(result.subscriptionStats.mode).toBe('factory');
      expect(result.subscriptionStats.monitoredPairs).toBe(2);
      expect(result.subscriptionStats.factorySubscriptionCount).toBe(3); // from mock
    });

    it('should fall back to legacy mode when no factory addresses', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue([]);

      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      const result = await manager.initialize(callbacks, ['0xpair1']);

      // Should NOT create factory service
      expect(MockFactorySubscriptionService).not.toHaveBeenCalled();
      expect(result.factorySubscriptionService).toBeNull();
      expect(result.subscriptionStats.mode).toBe('legacy');
      expect(result.useFactoryMode).toBe(false);
    });
  });

  describe('legacy subscription mode', () => {
    it('should use legacy mode when factory subscriptions disabled', async () => {
      const config = createDefaultConfig({
        subscriptionConfig: {
          useFactorySubscriptions: false,
          factorySubscriptionEnabledChains: [],
          factorySubscriptionRolloutPercent: 0,
        },
      });
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      const result = await manager.initialize(callbacks, ['0xpair1']);

      expect(MockFactorySubscriptionService).not.toHaveBeenCalled();
      expect(result.factorySubscriptionService).toBeNull();
      expect(result.useFactoryMode).toBe(false);
    });

    it('should subscribe to Sync/Swap/newHeads in legacy mode', async () => {
      const config = createDefaultConfig({
        subscriptionConfig: {
          useFactorySubscriptions: false,
          factorySubscriptionEnabledChains: [],
          factorySubscriptionRolloutPercent: 0,
        },
      });
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, ['0xpair1']);

      expect(mockWsManagerInstance.subscribe).toHaveBeenCalledTimes(3);
    });

    it('should set subscription stats for legacy mode', async () => {
      const config = createDefaultConfig({
        subscriptionConfig: {
          useFactorySubscriptions: false,
          factorySubscriptionEnabledChains: [],
          factorySubscriptionRolloutPercent: 0,
        },
      });
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      const result = await manager.initialize(callbacks, ['0xpair1', '0xpair2']);

      expect(result.subscriptionStats.mode).toBe('legacy');
      expect(result.subscriptionStats.legacySubscriptionCount).toBe(3);
      expect(result.subscriptionStats.factorySubscriptionCount).toBe(0);
      expect(result.subscriptionStats.monitoredPairs).toBe(2);
      expect(result.subscriptionStats.rpcReductionRatio).toBe(1);
    });
  });

  describe('callback wiring', () => {
    it('should wire onMessage callback to WebSocket message events', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      // Find the 'message' handler
      const messageCall = mockWsManagerInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'message'
      );
      expect(messageCall).toBeDefined();

      // Simulate a message
      const testMessage = { method: 'eth_subscription' };
      messageCall![1](testMessage);

      expect(callbacks.onMessage).toHaveBeenCalledWith(testMessage);
    });

    it('should wire onError callback to WebSocket error events', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      const errorCall = mockWsManagerInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'error'
      );
      expect(errorCall).toBeDefined();

      const testError = new Error('test error');
      errorCall![1](testError);

      expect(callbacks.onError).toHaveBeenCalledWith(testError);
    });

    it('should wire onDisconnected callback', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      const disconnectedCall = mockWsManagerInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'disconnected'
      );
      expect(disconnectedCall).toBeDefined();

      disconnectedCall![1]();

      expect(callbacks.onDisconnected).toHaveBeenCalled();
    });

    it('should wire onConnected callback', async () => {
      const config = createDefaultConfig();
      const manager = new SubscriptionManager(config);
      const callbacks = createMockCallbacks();

      await manager.initialize(callbacks, []);

      const connectedCall = mockWsManagerInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'connected'
      );
      expect(connectedCall).toBeDefined();

      connectedCall![1]();

      expect(callbacks.onConnected).toHaveBeenCalled();
    });
  });
});
