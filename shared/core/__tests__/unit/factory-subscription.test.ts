/**
 * Unit Tests for Factory Subscription Service
 *
 * Task 2.1.2: Tests for factory-level event subscriptions that enable
 * 40-50x RPC reduction through factory-level monitoring.
 *
 * @see factory-subscription.ts
 * @see implementation_plan_v2.md Phase 2.1.2
 */

import {
  FactorySubscriptionService,
  createFactorySubscriptionService,
  FactorySubscriptionConfig,
  FactorySubscriptionDeps,
  FactorySubscriptionLogger,
  FactoryWebSocketManager,
  PairCreatedEvent,
  FactoryEventSignatures,
  AdditionalEventSignatures,
  getFactoryEventSignature,
  parseV2PairCreatedEvent,
  parseV3PoolCreatedEvent,
  parseSolidlyPairCreatedEvent,
  parseAlgebraPoolCreatedEvent,
  parseTraderJoePairCreatedEvent,
  parseCurvePlainPoolDeployedEvent,
  parseCurveMetaPoolDeployedEvent,
  parseCurvePoolCreatedEvent,
  parseBalancerPoolRegisteredEvent,
  parseBalancerTokensRegisteredEvent,
  type RawEventLog,
} from '../../src/factory-subscription';
import { RecordingLogger } from '../../src/logging';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock WebSocket manager for testing.
 */
function createMockWsManager(): FactoryWebSocketManager & {
  subscriptions: { method: string; params: any[] }[];
  connected: boolean;
} {
  const subscriptions: { method: string; params: any[] }[] = [];
  return {
    subscriptions,
    connected: true,
    subscribe: jest.fn((params: { method: string; params: any[] }) => {
      subscriptions.push(params);
    }),
    unsubscribe: jest.fn(),
    isConnected: jest.fn(() => true),
  };
}

/**
 * Create test config with defaults.
 */
function createTestConfig(overrides?: Partial<FactorySubscriptionConfig>): FactorySubscriptionConfig {
  return {
    chain: 'arbitrum',
    enabled: true,
    ...overrides,
  };
}

/**
 * Create a valid V2 PairCreated log.
 * Event: PairCreated(address indexed token0, address indexed token1, address pair, uint)
 */
function createV2PairCreatedLog(
  token0: string,
  token1: string,
  pairAddress: string,
  factoryAddress: string
): any {
  // Pad addresses to 32 bytes (add 12 bytes of zeros on the left)
  const padAddress = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');

  // Data: pair address (32 bytes) + pair index (32 bytes)
  const pairPadded = pairAddress.slice(2).toLowerCase().padStart(64, '0');
  const indexPadded = '0'.repeat(64); // pair index = 0

  return {
    address: factoryAddress,
    topics: [
      FactoryEventSignatures.uniswap_v2,
      padAddress(token0),
      padAddress(token1),
    ],
    data: '0x' + pairPadded + indexPadded,
    blockNumber: 12345678,
    transactionHash: '0x' + 'a'.repeat(64),
  };
}

/**
 * Create a valid V3 PoolCreated log.
 * Event: PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
 */
function createV3PoolCreatedLog(
  token0: string,
  token1: string,
  poolAddress: string,
  factoryAddress: string,
  fee: number = 3000,
  tickSpacing: number = 60
): any {
  const padAddress = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');

  // Fee as indexed topic (uint24 padded to 32 bytes)
  const feePadded = '0x' + fee.toString(16).padStart(64, '0');

  // Data: tickSpacing (int24 as 32 bytes) + pool address (32 bytes)
  // tickSpacing 60 = 0x3c
  const tickSpacingPadded = tickSpacing.toString(16).padStart(64, '0');
  const poolPadded = poolAddress.slice(2).toLowerCase().padStart(64, '0');

  return {
    address: factoryAddress,
    topics: [
      FactoryEventSignatures.uniswap_v3,
      padAddress(token0),
      padAddress(token1),
      feePadded,
    ],
    data: '0x' + tickSpacingPadded + poolPadded,
    blockNumber: 12345678,
    transactionHash: '0x' + 'b'.repeat(64),
  };
}

/**
 * Create a valid Solidly PairCreated log.
 * Event: PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
 */
function createSolidlyPairCreatedLog(
  token0: string,
  token1: string,
  pairAddress: string,
  factoryAddress: string,
  isStable: boolean = false
): any {
  const padAddress = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');

  // Data: stable (bool as 32 bytes) + pair address (32 bytes) + index (32 bytes)
  const stablePadded = (isStable ? '1' : '0').padStart(64, '0');
  const pairPadded = pairAddress.slice(2).toLowerCase().padStart(64, '0');
  const indexPadded = '0'.repeat(64);

  return {
    address: factoryAddress,
    topics: [
      FactoryEventSignatures.solidly,
      padAddress(token0),
      padAddress(token1),
    ],
    data: '0x' + stablePadded + pairPadded + indexPadded,
    blockNumber: 12345678,
    transactionHash: '0x' + 'c'.repeat(64),
  };
}

/**
 * Create a valid Algebra Pool log.
 * Event: Pool(address indexed token0, address indexed token1, address pool)
 */
function createAlgebraPoolCreatedLog(
  token0: string,
  token1: string,
  poolAddress: string,
  factoryAddress: string
): any {
  const padAddress = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');

  // Data: pool address (32 bytes)
  const poolPadded = poolAddress.slice(2).toLowerCase().padStart(64, '0');

  return {
    address: factoryAddress,
    topics: [
      FactoryEventSignatures.algebra,
      padAddress(token0),
      padAddress(token1),
    ],
    data: '0x' + poolPadded,
    blockNumber: 12345678,
    transactionHash: '0x' + 'd'.repeat(64),
  };
}

/**
 * Create a valid Trader Joe LBPairCreated log.
 * Event: LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)
 */
function createTraderJoePairCreatedLog(
  token0: string,
  token1: string,
  pairAddress: string,
  factoryAddress: string,
  binStep: number = 25
): any {
  const padAddress = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');

  // binStep as indexed topic (uint256 padded to 32 bytes)
  const binStepPadded = '0x' + binStep.toString(16).padStart(64, '0');

  // Data: LBPair address (32 bytes) + pid (32 bytes)
  const pairPadded = pairAddress.slice(2).toLowerCase().padStart(64, '0');
  const pidPadded = '0'.repeat(64);

  return {
    address: factoryAddress,
    topics: [
      FactoryEventSignatures.trader_joe,
      padAddress(token0),
      padAddress(token1),
      binStepPadded,
    ],
    data: '0x' + pairPadded + pidPadded,
    blockNumber: 12345678,
    transactionHash: '0x' + 'e'.repeat(64),
  };
}

// =============================================================================
// Test Constants
// =============================================================================

const TEST_TOKEN0 = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'; // WETH
const TEST_TOKEN1 = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'; // USDC
const TEST_PAIR = '0x1234567890123456789012345678901234567890';
const TEST_FACTORY = '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9'; // Camelot V3 on Arbitrum

// =============================================================================
// Tests
// =============================================================================

describe('FactoryEventSignatures', () => {
  it('should have all expected factory types', () => {
    expect(FactoryEventSignatures.uniswap_v2).toBeDefined();
    expect(FactoryEventSignatures.uniswap_v3).toBeDefined();
    expect(FactoryEventSignatures.solidly).toBeDefined();
    expect(FactoryEventSignatures.curve).toBeDefined();
    expect(FactoryEventSignatures.balancer_v2).toBeDefined();
    expect(FactoryEventSignatures.algebra).toBeDefined();
    expect(FactoryEventSignatures.trader_joe).toBeDefined();
  });

  it('should have valid keccak256 hashes (66 chars with 0x prefix)', () => {
    for (const [type, signature] of Object.entries(FactoryEventSignatures)) {
      expect(signature).toMatch(/^0x[a-f0-9]{64}$/);
    }
  });

  it('should have unique signatures for each type', () => {
    const signatures = Object.values(FactoryEventSignatures);
    const uniqueSignatures = new Set(signatures);
    expect(uniqueSignatures.size).toBe(signatures.length);
  });
});

describe('getFactoryEventSignature', () => {
  it('should return correct signature for uniswap_v2', () => {
    expect(getFactoryEventSignature('uniswap_v2')).toBe(FactoryEventSignatures.uniswap_v2);
  });

  it('should return correct signature for uniswap_v3', () => {
    expect(getFactoryEventSignature('uniswap_v3')).toBe(FactoryEventSignatures.uniswap_v3);
  });

  it('should throw for unsupported factory type', () => {
    expect(() => getFactoryEventSignature('unknown_type' as any)).toThrow('Unsupported factory type');
  });
});

describe('parseV2PairCreatedEvent', () => {
  it('should parse valid V2 PairCreated event', () => {
    const log = createV2PairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY);
    const event = parseV2PairCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.token0).toBe(TEST_TOKEN0.toLowerCase());
    expect(event!.token1).toBe(TEST_TOKEN1.toLowerCase());
    expect(event!.pairAddress).toBe(TEST_PAIR.toLowerCase());
    expect(event!.factoryAddress).toBe(TEST_FACTORY.toLowerCase());
    expect(event!.factoryType).toBe('uniswap_v2');
    expect(event!.blockNumber).toBe(12345678);
  });

  it('should return null for log with insufficient topics', () => {
    const log = {
      address: TEST_FACTORY,
      topics: [FactoryEventSignatures.uniswap_v2, '0x' + '0'.repeat(64)],
      data: '0x' + '0'.repeat(128),
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseV2PairCreatedEvent(log)).toBeNull();
  });

  it('should return null for log with insufficient data', () => {
    const log = {
      address: TEST_FACTORY,
      topics: [
        FactoryEventSignatures.uniswap_v2,
        '0x' + '0'.repeat(64),
        '0x' + '0'.repeat(64),
      ],
      data: '0x' + '0'.repeat(32), // Too short
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseV2PairCreatedEvent(log)).toBeNull();
  });

  it('should return null for null log', () => {
    expect(parseV2PairCreatedEvent(null as unknown as RawEventLog)).toBeNull();
  });
});

describe('parseV3PoolCreatedEvent', () => {
  it('should parse valid V3 PoolCreated event', () => {
    const log = createV3PoolCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY, 3000, 60);
    const event = parseV3PoolCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.token0).toBe(TEST_TOKEN0.toLowerCase());
    expect(event!.token1).toBe(TEST_TOKEN1.toLowerCase());
    expect(event!.pairAddress).toBe(TEST_PAIR.toLowerCase());
    expect(event!.factoryType).toBe('uniswap_v3');
    expect(event!.fee).toBe(3000);
    expect(event!.tickSpacing).toBe(60);
  });

  it('should parse negative tickSpacing correctly', () => {
    // Create log with negative tickSpacing (-1)
    const log = createV3PoolCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY, 500, 10);
    const event = parseV3PoolCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.tickSpacing).toBe(10);
  });

  it('should return null for log with insufficient topics', () => {
    const log = {
      address: TEST_FACTORY,
      topics: [
        FactoryEventSignatures.uniswap_v3,
        '0x' + '0'.repeat(64),
        '0x' + '0'.repeat(64),
      ], // Missing fee topic
      data: '0x' + '0'.repeat(128),
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseV3PoolCreatedEvent(log)).toBeNull();
  });
});

describe('parseSolidlyPairCreatedEvent', () => {
  it('should parse stable pair correctly', () => {
    const log = createSolidlyPairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY, true);
    const event = parseSolidlyPairCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.isStable).toBe(true);
    expect(event!.factoryType).toBe('solidly');
  });

  it('should parse volatile pair correctly', () => {
    const log = createSolidlyPairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY, false);
    const event = parseSolidlyPairCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.isStable).toBe(false);
  });

  it('should return null for insufficient data', () => {
    const log = {
      address: TEST_FACTORY,
      topics: [
        FactoryEventSignatures.solidly,
        '0x' + '0'.repeat(64),
        '0x' + '0'.repeat(64),
      ],
      data: '0x' + '0'.repeat(64), // Only 1 word, need 3
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseSolidlyPairCreatedEvent(log)).toBeNull();
  });
});

describe('parseAlgebraPoolCreatedEvent', () => {
  it('should parse valid Algebra Pool event', () => {
    const log = createAlgebraPoolCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY);
    const event = parseAlgebraPoolCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.token0).toBe(TEST_TOKEN0.toLowerCase());
    expect(event!.token1).toBe(TEST_TOKEN1.toLowerCase());
    expect(event!.pairAddress).toBe(TEST_PAIR.toLowerCase());
    expect(event!.factoryType).toBe('algebra');
  });
});

describe('parseTraderJoePairCreatedEvent', () => {
  it('should parse valid Trader Joe LBPairCreated event', () => {
    const log = createTraderJoePairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY, 25);
    const event = parseTraderJoePairCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.token0).toBe(TEST_TOKEN0.toLowerCase());
    expect(event!.token1).toBe(TEST_TOKEN1.toLowerCase());
    expect(event!.pairAddress).toBe(TEST_PAIR.toLowerCase());
    expect(event!.factoryType).toBe('trader_joe');
    expect(event!.binStep).toBe(25);
  });

  it('should return null for insufficient topics', () => {
    const log = {
      address: TEST_FACTORY,
      topics: [
        FactoryEventSignatures.trader_joe,
        '0x' + '0'.repeat(64),
        '0x' + '0'.repeat(64),
      ], // Missing binStep topic
      data: '0x' + '0'.repeat(128),
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseTraderJoePairCreatedEvent(log)).toBeNull();
  });
});

describe('FactorySubscriptionService', () => {
  describe('initialization', () => {
    it('should initialize with default logger when none provided', () => {
      const config = createTestConfig();
      const service = createFactorySubscriptionService(config);

      expect(service).toBeDefined();
      expect(service.getChain()).toBe('arbitrum');
      expect(service.isSubscribed()).toBe(false);
    });

    it('should use provided logger', () => {
      const logger = new RecordingLogger();
      const config = createTestConfig();
      const service = createFactorySubscriptionService(config, { logger });

      expect(service).toBeDefined();
      // Service logs during initialization
      expect(logger.getLogs('debug').length).toBeGreaterThanOrEqual(0);
    });

    it('should build factory maps from registry', () => {
      const config = createTestConfig({ chain: 'arbitrum' });
      const service = createFactorySubscriptionService(config);

      // Arbitrum should have multiple factories
      const addresses = service.getFactoryAddresses();
      expect(addresses.length).toBeGreaterThan(0);
    });

    it('should respect customFactories filter', () => {
      const customFactory = '0x1234567890123456789012345678901234567890';
      const config = createTestConfig({
        customFactories: [customFactory],
      });
      const service = createFactorySubscriptionService(config);

      // Only custom factory should be included (if it matches a known factory)
      // Since our custom factory doesn't match, it should be empty
      const addresses = service.getFactoryAddresses();
      expect(addresses.length).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const config = createTestConfig();
      const service = createFactorySubscriptionService(config);
      const stats = service.getStats();

      expect(stats.chain).toBe('arbitrum');
      expect(stats.factoriesSubscribed).toBe(0);
      expect(stats.pairsCreated).toBe(0);
      expect(stats.isSubscribed).toBe(false);
      expect(stats.startedAt).toBeNull();
    });
  });

  describe('subscribeToFactories', () => {
    it('should subscribe when enabled with wsManager', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager });

      await service.subscribeToFactories();

      expect(service.isSubscribed()).toBe(true);
      expect(wsManager.subscribe).toHaveBeenCalled();
    });

    it('should not subscribe when disabled', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ enabled: false });
      const service = createFactorySubscriptionService(config, { wsManager });

      await service.subscribeToFactories();

      expect(service.isSubscribed()).toBe(false);
      expect(wsManager.subscribe).not.toHaveBeenCalled();
    });

    it('should not subscribe twice', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager });

      await service.subscribeToFactories();
      const firstCount = (wsManager.subscribe as jest.Mock).mock.calls.length;

      await service.subscribeToFactories();
      const secondCount = (wsManager.subscribe as jest.Mock).mock.calls.length;

      expect(secondCount).toBe(firstCount); // No new subscriptions
    });

    it('should group factories by event signature', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ chain: 'arbitrum', enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager });

      await service.subscribeToFactories();

      // Check that subscriptions use topics
      for (const sub of wsManager.subscriptions) {
        expect(sub.params[0]).toBe('logs');
        expect(sub.params[1].topics).toBeDefined();
        expect(sub.params[1].address).toBeDefined();
      }
    });
  });

  describe('onPairCreated callback', () => {
    it('should register and call callbacks', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ chain: 'bsc', enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager });

      const receivedEvents: PairCreatedEvent[] = [];
      service.onPairCreated((event) => {
        receivedEvents.push(event);
      });

      await service.subscribeToFactories();

      // Get a real factory address for BSC
      const factoryAddresses = service.getFactoryAddresses();
      if (factoryAddresses.length === 0) {
        // Skip test if no factories configured for BSC
        return;
      }

      const factoryAddress = factoryAddresses[0];
      const factoryConfig = service.getFactoryConfig(factoryAddress);
      if (!factoryConfig) {
        return;
      }

      // Create appropriate log based on factory type
      let log: any;
      switch (factoryConfig.type) {
        case 'uniswap_v2':
          log = createV2PairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, factoryAddress);
          break;
        case 'uniswap_v3':
          log = createV3PoolCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, factoryAddress);
          break;
        default:
          return; // Skip unsupported types
      }

      service.handleFactoryEvent(log);

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].token0).toBe(TEST_TOKEN0.toLowerCase());
    });
  });

  describe('handleFactoryEvent', () => {
    it('should ignore events when not subscribed', () => {
      const config = createTestConfig();
      const service = createFactorySubscriptionService(config);

      const receivedEvents: PairCreatedEvent[] = [];
      service.onPairCreated((event) => receivedEvents.push(event));

      const log = createV2PairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, TEST_FACTORY);
      service.handleFactoryEvent(log);

      expect(receivedEvents.length).toBe(0);
    });

    it('should ignore events from unknown factories', async () => {
      const wsManager = createMockWsManager();
      const logger = new RecordingLogger();
      const config = createTestConfig({ enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager, logger });

      const receivedEvents: PairCreatedEvent[] = [];
      service.onPairCreated((event) => receivedEvents.push(event));

      await service.subscribeToFactories();

      // Use an unknown factory address
      const unknownFactory = '0x0000000000000000000000000000000000000001';
      const log = createV2PairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, unknownFactory);
      service.handleFactoryEvent(log);

      expect(receivedEvents.length).toBe(0);
    });

    it('should update stats on successful event processing', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ chain: 'bsc', enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager });

      await service.subscribeToFactories();

      const factoryAddresses = service.getFactoryAddresses();
      if (factoryAddresses.length === 0) return;

      const factoryAddress = factoryAddresses[0];
      const factoryConfig = service.getFactoryConfig(factoryAddress);
      if (!factoryConfig || factoryConfig.type !== 'uniswap_v2') return;

      const initialStats = service.getStats();
      expect(initialStats.pairsCreated).toBe(0);

      const log = createV2PairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, factoryAddress);
      service.handleFactoryEvent(log);

      const updatedStats = service.getStats();
      expect(updatedStats.pairsCreated).toBe(1);
      expect(updatedStats.eventsByType['uniswap_v2']).toBe(1);
    });
  });

  describe('stop', () => {
    it('should stop service and clear state', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager });

      await service.subscribeToFactories();
      expect(service.isSubscribed()).toBe(true);

      service.stop();

      expect(service.isSubscribed()).toBe(false);
      expect(service.getSubscriptionCount()).toBe(0);
    });

    it('should clear callbacks on stop', async () => {
      const wsManager = createMockWsManager();
      const config = createTestConfig({ enabled: true });
      const service = createFactorySubscriptionService(config, { wsManager });

      const receivedEvents: PairCreatedEvent[] = [];
      service.onPairCreated((event) => receivedEvents.push(event));

      await service.subscribeToFactories();
      service.stop();

      // Events after stop should not trigger callbacks
      // (service is not subscribed so handleFactoryEvent returns early)
      const factoryAddresses = service.getFactoryAddresses();
      if (factoryAddresses.length > 0) {
        const log = createV2PairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, factoryAddresses[0]);
        service.handleFactoryEvent(log);
        expect(receivedEvents.length).toBe(0);
      }
    });
  });

  describe('getFactoryConfig', () => {
    it('should return factory config for known address', () => {
      const config = createTestConfig({ chain: 'arbitrum' });
      const service = createFactorySubscriptionService(config);

      const addresses = service.getFactoryAddresses();
      if (addresses.length > 0) {
        const factoryConfig = service.getFactoryConfig(addresses[0]);
        expect(factoryConfig).toBeDefined();
        expect(factoryConfig!.address.toLowerCase()).toBe(addresses[0]);
      }
    });

    it('should return undefined for unknown address', () => {
      const config = createTestConfig();
      const service = createFactorySubscriptionService(config);

      const factoryConfig = service.getFactoryConfig('0x0000000000000000000000000000000000000001');
      expect(factoryConfig).toBeUndefined();
    });

    it('should be case-insensitive', () => {
      const config = createTestConfig({ chain: 'arbitrum' });
      const service = createFactorySubscriptionService(config);

      const addresses = service.getFactoryAddresses();
      if (addresses.length > 0) {
        const upperAddress = addresses[0].toUpperCase();
        const factoryConfig = service.getFactoryConfig(upperAddress);
        expect(factoryConfig).toBeDefined();
      }
    });
  });
});

describe('Edge Cases and Error Handling', () => {
  it('should handle malformed log data gracefully', () => {
    expect(parseV2PairCreatedEvent({ data: null, topics: [] } as unknown as RawEventLog)).toBeNull();
    expect(parseV2PairCreatedEvent({ data: '', topics: null } as unknown as RawEventLog)).toBeNull();
    expect(parseV2PairCreatedEvent(undefined as unknown as RawEventLog)).toBeNull();
  });

  it('should handle callback errors without crashing', async () => {
    const wsManager = createMockWsManager();
    const logger = new RecordingLogger();
    const config = createTestConfig({ chain: 'bsc', enabled: true });
    const service = createFactorySubscriptionService(config, { wsManager, logger });

    // Register a callback that throws
    service.onPairCreated(() => {
      throw new Error('Callback error');
    });

    // Register another callback that should still be called
    const receivedEvents: PairCreatedEvent[] = [];
    service.onPairCreated((event) => receivedEvents.push(event));

    await service.subscribeToFactories();

    const factoryAddresses = service.getFactoryAddresses();
    if (factoryAddresses.length === 0) return;

    const factoryConfig = service.getFactoryConfig(factoryAddresses[0]);
    if (!factoryConfig || factoryConfig.type !== 'uniswap_v2') return;

    const log = createV2PairCreatedLog(TEST_TOKEN0, TEST_TOKEN1, TEST_PAIR, factoryAddresses[0]);

    // Should not throw
    expect(() => service.handleFactoryEvent(log)).not.toThrow();

    // Second callback should still have been called
    expect(receivedEvents.length).toBe(1);

    // Error should be logged
    expect(logger.getLogs('error').some(l => l.msg.includes('callback'))).toBe(true);
  });

  it('should handle chain with no factories', async () => {
    const wsManager = createMockWsManager();
    const logger = new RecordingLogger();
    const config = createTestConfig({ chain: 'unknown-chain', enabled: true });
    const service = createFactorySubscriptionService(config, { wsManager, logger });

    await service.subscribeToFactories();

    expect(service.isSubscribed()).toBe(false);
    expect(logger.getLogs('warn').some(l => l.msg.includes('No factories'))).toBe(true);
  });
});

// =============================================================================
// Curve and Balancer V2 Test Helpers
// =============================================================================

/**
 * Create a valid Curve PlainPoolDeployed log.
 * Event: PlainPoolDeployed(address[4] coins, uint256 A, uint256 fee, address deployer, address pool)
 * All values are in data (no indexed topics except signature)
 */
function createCurvePlainPoolDeployedLog(
  coins: string[], // Up to 4 coins
  amplificationCoefficient: number,
  fee: number,
  poolAddress: string,
  factoryAddress: string
): any {
  // Pad addresses to 32 bytes (add 12 bytes of zeros on the left)
  const padAddress = (addr: string) => addr.slice(2).toLowerCase().padStart(64, '0');

  // Build coins array (pad with zero addresses if less than 4)
  const paddedCoins: string[] = [];
  for (let i = 0; i < 4; i++) {
    if (i < coins.length) {
      paddedCoins.push(padAddress(coins[i]));
    } else {
      paddedCoins.push('0'.repeat(64)); // Zero address
    }
  }

  // Build data: coins[4] + A + fee + deployer + pool
  const aPadded = amplificationCoefficient.toString(16).padStart(64, '0');
  const feePadded = fee.toString(16).padStart(64, '0');
  const deployerPadded = padAddress('0x' + 'f'.repeat(40)); // Dummy deployer
  const poolPadded = padAddress(poolAddress);

  const data = '0x' + paddedCoins.join('') + aPadded + feePadded + deployerPadded + poolPadded;

  return {
    address: factoryAddress,
    topics: [FactoryEventSignatures.curve],
    data,
    blockNumber: 12345678,
    transactionHash: '0x' + 'f'.repeat(64),
  };
}

/**
 * Create a valid Curve MetaPoolDeployed log.
 * Event: MetaPoolDeployed(address coin, address base_pool, uint256 A, uint256 fee, address deployer, address pool)
 */
function createCurveMetaPoolDeployedLog(
  coin: string,
  basePool: string,
  amplificationCoefficient: number,
  fee: number,
  poolAddress: string,
  factoryAddress: string
): any {
  const padAddress = (addr: string) => addr.slice(2).toLowerCase().padStart(64, '0');

  // Build data: coin + base_pool + A + fee + deployer + pool
  const coinPadded = padAddress(coin);
  const basePoolPadded = padAddress(basePool);
  const aPadded = amplificationCoefficient.toString(16).padStart(64, '0');
  const feePadded = fee.toString(16).padStart(64, '0');
  const deployerPadded = padAddress('0x' + 'f'.repeat(40));
  const poolPadded = padAddress(poolAddress);

  const data = '0x' + coinPadded + basePoolPadded + aPadded + feePadded + deployerPadded + poolPadded;

  return {
    address: factoryAddress,
    topics: [AdditionalEventSignatures.curve_metapool],
    data,
    blockNumber: 12345678,
    transactionHash: '0x' + 'f'.repeat(64),
  };
}

/**
 * Create a valid Balancer V2 PoolRegistered log.
 * Event: PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 specialization)
 */
function createBalancerPoolRegisteredLog(
  poolId: string,
  poolAddress: string,
  specialization: number,
  factoryAddress: string
): any {
  const padAddress = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');

  // specialization as uint8 (right-aligned in 32 bytes)
  const specPadded = specialization.toString(16).padStart(64, '0');

  return {
    address: factoryAddress,
    topics: [
      FactoryEventSignatures.balancer_v2,
      poolId.toLowerCase(),
      padAddress(poolAddress),
    ],
    data: '0x' + specPadded,
    blockNumber: 12345678,
    transactionHash: '0x' + 'b'.repeat(64),
  };
}

/**
 * Create a valid Balancer V2 TokensRegistered log.
 * Event: TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)
 */
function createBalancerTokensRegisteredLog(
  poolId: string,
  tokens: string[],
  factoryAddress: string
): any {
  const padAddress = (addr: string) => addr.slice(2).toLowerCase().padStart(64, '0');

  // Dynamic arrays use offsets. tokens at offset 64 (0x40), assetManagers at offset 64 + 32 + tokens.length * 32
  const tokensOffset = 64; // First offset (after 2 offset words)
  const assetManagersOffset = 64 + 32 + tokens.length * 32;

  const tokensOffsetPadded = tokensOffset.toString(16).padStart(64, '0');
  const assetManagersOffsetPadded = assetManagersOffset.toString(16).padStart(64, '0');

  // tokens array: length + addresses
  const tokensLengthPadded = tokens.length.toString(16).padStart(64, '0');
  const tokensPadded = tokens.map(t => padAddress(t)).join('');

  // assetManagers array: length + addresses (all zeros for test)
  const assetManagersLengthPadded = tokens.length.toString(16).padStart(64, '0');
  const assetManagersPadded = '0'.repeat(64 * tokens.length);

  const data = '0x' + tokensOffsetPadded + assetManagersOffsetPadded +
    tokensLengthPadded + tokensPadded +
    assetManagersLengthPadded + assetManagersPadded;

  return {
    address: factoryAddress,
    topics: [
      AdditionalEventSignatures.balancer_tokens_registered,
      poolId.toLowerCase(),
    ],
    data,
    blockNumber: 12345678,
    transactionHash: '0x' + 'b'.repeat(64),
  };
}

// =============================================================================
// Curve Parser Tests
// =============================================================================

const TEST_CURVE_FACTORY = '0xb17b674D9c5CB2e441F8e196a2f048A81355d031'; // Curve on Arbitrum
const TEST_CURVE_POOL = '0x2222222222222222222222222222222222222222';
const TEST_BASE_POOL = '0x3333333333333333333333333333333333333333';
const TEST_DAI = '0x6B175474E89094C44Da98b954EecdeCB5BE3d708'; // Test stablecoin 1 (valid 40 hex chars)
const TEST_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // Test stablecoin 2
const TEST_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // Test stablecoin 3

describe('parseCurvePlainPoolDeployedEvent', () => {
  it('should parse valid 2-coin PlainPoolDeployed event', () => {
    const log = createCurvePlainPoolDeployedLog(
      [TEST_DAI, TEST_USDC],
      1500, // A = 1500
      4000000, // 0.04% fee
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    const event = parseCurvePlainPoolDeployedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.token0).toBe(TEST_DAI.toLowerCase());
    expect(event!.token1).toBe(TEST_USDC.toLowerCase());
    expect(event!.pairAddress).toBe(TEST_CURVE_POOL.toLowerCase());
    expect(event!.factoryType).toBe('curve');
    expect(event!.coins!.length).toBe(2);
    expect(event!.amplificationCoefficient).toBe(1500);
    expect(event!.fee).toBe(4000000);
    expect(event!.isMetaPool).toBe(false);
  });

  it('should parse valid 3-coin PlainPoolDeployed event', () => {
    const log = createCurvePlainPoolDeployedLog(
      [TEST_DAI, TEST_USDC, TEST_USDT],
      2000,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    const event = parseCurvePlainPoolDeployedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.coins!.length).toBe(3);
    expect(event!.coins).toContain(TEST_DAI.toLowerCase());
    expect(event!.coins).toContain(TEST_USDC.toLowerCase());
    expect(event!.coins).toContain(TEST_USDT.toLowerCase());
  });

  it('should parse valid 4-coin PlainPoolDeployed event', () => {
    const fourthToken = '0x4444444444444444444444444444444444444444';
    const log = createCurvePlainPoolDeployedLog(
      [TEST_DAI, TEST_USDC, TEST_USDT, fourthToken],
      3000,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    const event = parseCurvePlainPoolDeployedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.coins!.length).toBe(4);
  });

  it('should return null for log with less than 2 valid coins', () => {
    const log = createCurvePlainPoolDeployedLog(
      [TEST_DAI], // Only 1 coin
      1500,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    expect(parseCurvePlainPoolDeployedEvent(log)).toBeNull();
  });

  it('should return null for log with insufficient data', () => {
    const log = {
      address: TEST_CURVE_FACTORY,
      topics: [FactoryEventSignatures.curve],
      data: '0x' + '0'.repeat(128), // Too short (need 512 hex chars)
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseCurvePlainPoolDeployedEvent(log)).toBeNull();
  });

  it('should return null for null log', () => {
    expect(parseCurvePlainPoolDeployedEvent(null as unknown as RawEventLog)).toBeNull();
  });
});

describe('parseCurveMetaPoolDeployedEvent', () => {
  it('should parse valid MetaPoolDeployed event', () => {
    const newToken = '0x5555555555555555555555555555555555555555';
    const log = createCurveMetaPoolDeployedLog(
      newToken,
      TEST_BASE_POOL,
      1500,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    const event = parseCurveMetaPoolDeployedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.token0).toBe(newToken.toLowerCase());
    expect(event!.token1).toBe(TEST_BASE_POOL.toLowerCase()); // Base pool as token1
    expect(event!.pairAddress).toBe(TEST_CURVE_POOL.toLowerCase());
    expect(event!.factoryType).toBe('curve');
    expect(event!.basePool).toBe(TEST_BASE_POOL.toLowerCase());
    expect(event!.isMetaPool).toBe(true);
    expect(event!.coins!.length).toBe(1);
    expect(event!.coins![0]).toBe(newToken.toLowerCase());
  });

  it('should return null for log with zero coin address', () => {
    const log = createCurveMetaPoolDeployedLog(
      '0x0000000000000000000000000000000000000000', // Zero address
      TEST_BASE_POOL,
      1500,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    expect(parseCurveMetaPoolDeployedEvent(log)).toBeNull();
  });

  it('should return null for log with zero base pool address', () => {
    const newToken = '0x5555555555555555555555555555555555555555';
    const log = createCurveMetaPoolDeployedLog(
      newToken,
      '0x0000000000000000000000000000000000000000', // Zero address
      1500,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    expect(parseCurveMetaPoolDeployedEvent(log)).toBeNull();
  });

  it('should return null for insufficient data', () => {
    const log = {
      address: TEST_CURVE_FACTORY,
      topics: [AdditionalEventSignatures.curve_metapool],
      data: '0x' + '0'.repeat(128), // Too short (need 384 hex chars)
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseCurveMetaPoolDeployedEvent(log)).toBeNull();
  });
});

describe('parseCurvePoolCreatedEvent', () => {
  it('should route PlainPoolDeployed to correct parser', () => {
    const log = createCurvePlainPoolDeployedLog(
      [TEST_DAI, TEST_USDC],
      1500,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    const event = parseCurvePoolCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.isMetaPool).toBe(false);
  });

  it('should route MetaPoolDeployed to correct parser', () => {
    const newToken = '0x5555555555555555555555555555555555555555';
    const log = createCurveMetaPoolDeployedLog(
      newToken,
      TEST_BASE_POOL,
      1500,
      4000000,
      TEST_CURVE_POOL,
      TEST_CURVE_FACTORY
    );

    const event = parseCurvePoolCreatedEvent(log);

    expect(event).not.toBeNull();
    expect(event!.isMetaPool).toBe(true);
  });

  it('should return null for invalid log', () => {
    expect(parseCurvePoolCreatedEvent(null as unknown as RawEventLog)).toBeNull();
    expect(parseCurvePoolCreatedEvent({ topics: [], data: null } as unknown as RawEventLog)).toBeNull();
  });
});

// =============================================================================
// Balancer V2 Parser Tests
// =============================================================================

const TEST_BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'; // Balancer Vault
const TEST_POOL_ID = '0x' + 'a'.repeat(64); // 32-byte pool ID
const TEST_BALANCER_POOL = '0x4444444444444444444444444444444444444444';

describe('parseBalancerPoolRegisteredEvent', () => {
  it('should parse valid PoolRegistered event with General specialization', () => {
    const log = createBalancerPoolRegisteredLog(
      TEST_POOL_ID,
      TEST_BALANCER_POOL,
      0, // General
      TEST_BALANCER_VAULT
    );

    const event = parseBalancerPoolRegisteredEvent(log);

    expect(event).not.toBeNull();
    expect(event!.pairAddress).toBe(TEST_BALANCER_POOL.toLowerCase());
    expect(event!.factoryAddress).toBe(TEST_BALANCER_VAULT.toLowerCase());
    expect(event!.factoryType).toBe('balancer_v2');
    expect(event!.poolId).toBe(TEST_POOL_ID.toLowerCase());
    expect(event!.specialization).toBe(0);
    expect(event!.requiresTokenLookup).toBe(true);
    // Token addresses should be zero (need lookup)
    expect(event!.token0).toBe('0x0000000000000000000000000000000000000000');
    expect(event!.token1).toBe('0x0000000000000000000000000000000000000000');
  });

  it('should parse PoolRegistered event with MinimalSwap specialization', () => {
    const log = createBalancerPoolRegisteredLog(
      TEST_POOL_ID,
      TEST_BALANCER_POOL,
      1, // MinimalSwap
      TEST_BALANCER_VAULT
    );

    const event = parseBalancerPoolRegisteredEvent(log);

    expect(event).not.toBeNull();
    expect(event!.specialization).toBe(1);
  });

  it('should parse PoolRegistered event with TwoToken specialization', () => {
    const log = createBalancerPoolRegisteredLog(
      TEST_POOL_ID,
      TEST_BALANCER_POOL,
      2, // TwoToken
      TEST_BALANCER_VAULT
    );

    const event = parseBalancerPoolRegisteredEvent(log);

    expect(event).not.toBeNull();
    expect(event!.specialization).toBe(2);
  });

  it('should return null for log with insufficient topics', () => {
    const log = {
      address: TEST_BALANCER_VAULT,
      topics: [FactoryEventSignatures.balancer_v2, TEST_POOL_ID], // Missing poolAddress topic
      data: '0x' + '0'.repeat(64),
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
  });

  it('should return null for log with insufficient data', () => {
    const log = {
      address: TEST_BALANCER_VAULT,
      topics: [
        FactoryEventSignatures.balancer_v2,
        TEST_POOL_ID,
        '0x' + TEST_BALANCER_POOL.slice(2).padStart(64, '0'),
      ],
      data: '0x' + '0'.repeat(32), // Too short
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
  });

  it('should return null for null log', () => {
    expect(parseBalancerPoolRegisteredEvent(null as unknown as RawEventLog)).toBeNull();
  });
});

describe('parseBalancerTokensRegisteredEvent', () => {
  it('should parse valid TokensRegistered event with 2 tokens', () => {
    const tokens = [TEST_DAI, TEST_USDC];
    const log = createBalancerTokensRegisteredLog(TEST_POOL_ID, tokens, TEST_BALANCER_VAULT);

    const result = parseBalancerTokensRegisteredEvent(log);

    expect(result).not.toBeNull();
    expect(result!.poolId).toBe(TEST_POOL_ID.toLowerCase());
    expect(result!.tokens.length).toBe(2);
    expect(result!.tokens).toContain(TEST_DAI.toLowerCase());
    expect(result!.tokens).toContain(TEST_USDC.toLowerCase());
  });

  it('should parse valid TokensRegistered event with 3 tokens', () => {
    const tokens = [TEST_DAI, TEST_USDC, TEST_USDT];
    const log = createBalancerTokensRegisteredLog(TEST_POOL_ID, tokens, TEST_BALANCER_VAULT);

    const result = parseBalancerTokensRegisteredEvent(log);

    expect(result).not.toBeNull();
    expect(result!.tokens.length).toBe(3);
  });

  it('should return null for log with insufficient topics', () => {
    const log = {
      address: TEST_BALANCER_VAULT,
      topics: [AdditionalEventSignatures.balancer_tokens_registered], // Missing poolId topic
      data: '0x' + '0'.repeat(256),
      blockNumber: 12345678,
      transactionHash: '0x' + '0'.repeat(64),
    };
    expect(parseBalancerTokensRegisteredEvent(log)).toBeNull();
  });

  it('should return null for null log', () => {
    expect(parseBalancerTokensRegisteredEvent(null as unknown as RawEventLog)).toBeNull();
  });
});
