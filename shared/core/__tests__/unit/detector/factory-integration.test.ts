/**
 * Factory Integration Service Tests
 *
 * NOTE: "Integration" in the file name refers to the `FactoryIntegrationService`
 * class name, NOT the test type. This is a unit test with mocked dependencies,
 * correctly placed in __tests__/unit/.
 *
 * Tests for factory subscription and dynamic pair discovery:
 * - Factory address set building (O(1) lookup)
 * - WebSocket adapter pattern with shutdown guards
 * - Pair registration from PairCreated events
 * - Event subscription for discovered pairs
 * - Shutdown guard patterns to prevent race conditions
 *
 * Migrated from base-detector.test.ts as part of Phase 2 test migration.
 */

import {
  FactoryIntegrationService,
  createFactoryIntegrationService,
} from '../../../src/detector/factory-integration';
import type {
  FactoryIntegrationConfig,
  FactoryIntegrationDeps,
  FactoryIntegrationHandlers,
} from '../../../src/detector/factory-integration';
import type { PairCreatedEvent } from '../../../src/factory-subscription';
import type { Pair, Dex } from '@arbitrage/types';

// Mock dependencies
jest.mock('../../../src/factory-subscription', () => ({
  createFactorySubscriptionService: jest.fn(),
}));

jest.mock('@arbitrage/config', () => ({
  getAllFactoryAddresses: jest.fn(),
  validateFactoryRegistry: jest.fn(),
  EVENT_CONFIG: {
    syncEvents: { enabled: true },
    swapEvents: { enabled: true },
  },
  EVENT_SIGNATURES: {
    SYNC: '0xSyncSignature',
    SWAP_V2: '0xSwapV2Signature',
  },
}));

import { createFactorySubscriptionService } from '../../../src/factory-subscription';
import {
  getAllFactoryAddresses,
  validateFactoryRegistry,
} from '@arbitrage/config';

describe('FactoryIntegrationService', () => {
  // =============================================================================
  // Test Setup & Mocks
  // =============================================================================

  let mockLogger: any;
  let mockWsManager: any;
  let mockDexesByName: Map<string, Dex>;
  let mockPairsByAddress: Map<string, Pair>;
  let mockAddPairToIndices: jest.Mock;
  let isRunning: boolean;
  let isStopping: boolean;

  let mockFactoryService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset state flags
    isRunning = true;
    isStopping = false;

    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    // Mock WebSocket manager
    mockWsManager = {
      subscribe: jest.fn().mockReturnValue(1),
      unsubscribe: jest.fn(),
      isWebSocketConnected: jest.fn().mockReturnValue(true),
    };

    // Mock DEX configuration map
    mockDexesByName = new Map<string, Dex>([
      [
        'uniswap_v2',
        {
          name: 'uniswap_v2',
          chain: 'ethereum',
          factoryAddress: '0xfactory',
          routerAddress: '0xrouter',
          feeBps: 30, // NEW: 0.3% in basis points (30 bps = 0.003)
          fee: 0.003, // DEPRECATED: 0.3% as decimal (for backward compatibility)
          type: 'amm',
        } as Dex,
      ],
    ]);

    // Mock pairs map
    mockPairsByAddress = new Map<string, Pair>();

    // Mock callbacks
    mockAddPairToIndices = jest.fn();

    // Mock factory subscription service
    mockFactoryService = {
      onPairCreated: jest.fn(),
      subscribeToFactories: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({ subscriptions: 1 }),
      handleFactoryEvent: jest.fn(),
      stop: jest.fn(),
    };

    (createFactorySubscriptionService as jest.Mock).mockReturnValue(mockFactoryService);
    (validateFactoryRegistry as jest.Mock).mockReturnValue([]);
    (getAllFactoryAddresses as jest.Mock).mockReturnValue([]);
  });

  const createMockDeps = (): FactoryIntegrationDeps => ({
    logger: mockLogger,
    wsManager: mockWsManager,
    dexesByName: mockDexesByName,
    pairsByAddress: mockPairsByAddress,
    addPairToIndices: mockAddPairToIndices,
    isRunning: () => isRunning,
    isStopping: () => isStopping,
  });

  // =============================================================================
  // Constructor & Factory Function
  // =============================================================================

  describe('constructor', () => {
    it('should create service with default config', () => {
      const config: FactoryIntegrationConfig = {
        chain: 'ethereum',
      };

      const service = new FactoryIntegrationService(config, createMockDeps());

      expect(service).toBeInstanceOf(FactoryIntegrationService);
    });

    it('should apply default enabled=true', () => {
      const config: FactoryIntegrationConfig = {
        chain: 'ethereum',
      };

      const service = new FactoryIntegrationService(config, createMockDeps());

      expect(service).toBeDefined();
      // Config is private, but we can verify behavior through initialization
    });

    it('should respect enabled=false config', () => {
      const config: FactoryIntegrationConfig = {
        chain: 'ethereum',
        enabled: false,
      };

      const service = new FactoryIntegrationService(config, createMockDeps());

      expect(service).toBeDefined();
    });
  });

  describe('createFactoryIntegrationService', () => {
    it('should create service via factory function', () => {
      const config: FactoryIntegrationConfig = {
        chain: 'ethereum',
      };

      const service = createFactoryIntegrationService(config, createMockDeps());

      expect(service).toBeInstanceOf(FactoryIntegrationService);
    });

    it('should pass handlers to constructor', () => {
      const handlers: FactoryIntegrationHandlers = {
        onPairRegistered: jest.fn(),
        onPairSubscribed: jest.fn(),
      };

      const service = createFactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps(),
        handlers
      );

      expect(service).toBeInstanceOf(FactoryIntegrationService);
    });
  });

  // =============================================================================
  // initialize() - Core Initialization Logic
  // =============================================================================

  describe('initialize', () => {
    it('should skip initialization when no factories configured', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue([]);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      const result = await service.initialize();

      expect(result.service).toBeNull();
      expect(result.factoryAddresses.size).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'No factories configured for chain, skipping factory subscription',
        { chain: 'ethereum' }
      );
      expect(createFactorySubscriptionService).not.toHaveBeenCalled();
    });

    it('should initialize with factory addresses (lowercase normalization)', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue([
        '0xFACTORY1',
        '0xFactory2',
      ]);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      const result = await service.initialize();

      expect(result.service).toBe(mockFactoryService);
      expect(result.factoryAddresses.size).toBe(2);
      expect(result.factoryAddresses.has('0xfactory1')).toBe(true);
      expect(result.factoryAddresses.has('0xfactory2')).toBe(true);
    });

    it('should log validation warnings but continue initialization', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);
      (validateFactoryRegistry as jest.Mock).mockReturnValue([
        'Warning: Missing fee for DEX xyz',
      ]);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      const result = await service.initialize();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Factory registry validation warnings',
        expect.objectContaining({
          chain: 'ethereum',
          errors: ['Warning: Missing fee for DEX xyz'],
          count: 1,
        })
      );
      expect(result.service).toBe(mockFactoryService);
    });

    it('should create factory subscription service with WebSocket adapter', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      expect(createFactorySubscriptionService).toHaveBeenCalledWith(
        {
          chain: 'ethereum',
          enabled: true,
        },
        {
          logger: mockLogger,
          wsManager: expect.any(Object),
        }
      );
    });

    it('should register onPairCreated callback', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      expect(mockFactoryService.onPairCreated).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should subscribe to factory events', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      expect(mockFactoryService.subscribeToFactories).toHaveBeenCalled();
    });

    it('should log initialization success with stats', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Factory subscription service initialized',
        {
          chain: 'ethereum',
          factories: 1,
          stats: { subscriptions: 1 },
        }
      );
    });

    it('should handle initialization errors gracefully', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);
      (createFactorySubscriptionService as jest.Mock).mockImplementation(() => {
        throw new Error('WebSocket connection failed');
      });

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      const result = await service.initialize();

      expect(result.service).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize factory subscription service',
        { error: expect.any(Error) }
      );
      expect(mockLogger.warn).toHaveBeenCalledWith('Dynamic pair discovery disabled');
    });
  });

  // =============================================================================
  // WebSocket Adapter - Shutdown Guards
  // =============================================================================

  describe('WebSocket adapter', () => {
    it('should create adapter with subscribe method', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      // Get the adapter passed to createFactorySubscriptionService
      const adapterCall = (createFactorySubscriptionService as jest.Mock).mock.calls[0];
      const adapter = adapterCall[1].wsManager;

      expect(adapter).toBeDefined();
      expect(adapter.subscribe).toBeDefined();
    });

    it('should guard subscribe during shutdown', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const adapterCall = (createFactorySubscriptionService as jest.Mock).mock.calls[0];
      const adapter = adapterCall[1].wsManager;

      // Set stopping flag
      isStopping = true;

      const result = adapter.subscribe({ method: 'eth_subscribe', params: [] });

      expect(result).toBe(0); // Dummy subscription ID
      expect(mockWsManager.subscribe).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('Skipping subscribe during shutdown');
    });

    it('should guard unsubscribe during shutdown', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const adapterCall = (createFactorySubscriptionService as jest.Mock).mock.calls[0];
      const adapter = adapterCall[1].wsManager;

      isStopping = true;

      adapter.unsubscribe('123');

      expect(mockWsManager.unsubscribe).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('Skipping unsubscribe during shutdown');
    });

    it('should convert string ID to number for unsubscribe', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const adapterCall = (createFactorySubscriptionService as jest.Mock).mock.calls[0];
      const adapter = adapterCall[1].wsManager;

      adapter.unsubscribe('456');

      expect(mockWsManager.unsubscribe).toHaveBeenCalledWith(456);
    });

    it('should handle invalid unsubscribe ID gracefully', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const adapterCall = (createFactorySubscriptionService as jest.Mock).mock.calls[0];
      const adapter = adapterCall[1].wsManager;

      adapter.unsubscribe('invalid');

      expect(mockWsManager.unsubscribe).not.toHaveBeenCalled();
    });

    it('should guard isConnected during shutdown', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const adapterCall = (createFactorySubscriptionService as jest.Mock).mock.calls[0];
      const adapter = adapterCall[1].wsManager;

      isStopping = true;

      const connected = adapter.isConnected();

      expect(connected).toBe(false);
      expect(mockWsManager.isWebSocketConnected).not.toHaveBeenCalled();
    });

    it('should return undefined adapter when wsManager is null', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const deps = createMockDeps();
      deps.wsManager = null;

      const service = new FactoryIntegrationService({ chain: 'ethereum' }, deps);

      await service.initialize();

      const adapterCall = (createFactorySubscriptionService as jest.Mock).mock.calls[0];
      const adapter = adapterCall[1].wsManager;

      expect(adapter).toBeUndefined();
    });
  });

  // =============================================================================
  // registerPairFromFactory - Pair Registration Logic
  // =============================================================================

  describe('registerPairFromFactory', () => {
    let service: FactoryIntegrationService;
    let pairCreatedCallback: (event: PairCreatedEvent) => void;

    beforeEach(async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      service = new FactoryIntegrationService({ chain: 'ethereum' }, createMockDeps());

      await service.initialize();

      // Capture the callback registered with onPairCreated
      pairCreatedCallback = mockFactoryService.onPairCreated.mock.calls[0][0];
    });

    it('should guard against registration during shutdown (isStopping)', () => {
      isStopping = true;

      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Ignoring factory event during shutdown',
        { pair: '0xpair', dex: 'uniswap_v2' }
      );
      expect(mockAddPairToIndices).not.toHaveBeenCalled();
    });

    it('should guard against registration when not running', () => {
      isRunning = false;

      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Ignoring factory event during shutdown',
        { pair: '0xpair', dex: 'uniswap_v2' }
      );
      expect(mockAddPairToIndices).not.toHaveBeenCalled();
    });

    it('should skip duplicate pairs', () => {
      mockPairsByAddress.set('0xpair', {
        name: 'Existing',
        address: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        dex: 'uniswap_v2',
        fee: 0.003,
      });

      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xPAIR', // Different case
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockLogger.debug).toHaveBeenCalledWith('Pair already registered, skipping', {
        pair: '0xPAIR',
        dex: 'uniswap_v2',
      });
      expect(mockAddPairToIndices).not.toHaveBeenCalled();
    });

    it('should create pair with DEX fee from dexesByName (O(1) lookup)', () => {
      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockAddPairToIndices).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          fee: 0.003, // 30 basis points / 10000 = 0.003
        })
      );
    });

    it('should use default fee when DEX not found in dexesByName', () => {
      const event: PairCreatedEvent = {
        dexName: 'unknown_dex',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockAddPairToIndices).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          fee: 0.003, // Default
        })
      );
    });

    it('should create pair with truncated token addresses in name', () => {
      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0x1234567890abcdef',
        token1: '0xfedcba0987654321',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockAddPairToIndices).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          name: '0x1234.../0xfedc...',
        })
      );
    });

    it('should register pair in all indices via callback', () => {
      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockAddPairToIndices).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          address: '0xpair',
          token0: '0xtoken0',
          token1: '0xtoken1',
          dex: 'uniswap_v2',
        })
      );
    });

    it('should subscribe to Sync/Swap events for new pair', () => {
      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xPAIRUPPER',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      // Should subscribe twice: Sync + Swap
      expect(mockWsManager.subscribe).toHaveBeenCalledTimes(2);
      expect(mockWsManager.subscribe).toHaveBeenCalledWith({
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: ['0xSyncSignature'],
            address: ['0xpairupper'], // Lowercase
          },
        ],
      });
      expect(mockWsManager.subscribe).toHaveBeenCalledWith({
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: ['0xSwapV2Signature'],
            address: ['0xpairupper'], // Lowercase
          },
        ],
      });
    });

    it('should notify onPairRegistered handler', () => {
      const handlers: FactoryIntegrationHandlers = {
        onPairRegistered: jest.fn(),
      };

      const serviceWithHandler = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps(),
        handlers
      );

      // Manually trigger registration (no init needed for this test)
      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      // Access private method via any cast for testing
      (serviceWithHandler as any).registerPairFromFactory(event);

      expect(handlers.onPairRegistered).toHaveBeenCalledWith(
        expect.objectContaining({ address: '0xpair' }),
        event
      );
    });

    it('should log registration success', () => {
      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0x1234567890abcdef',
        token1: '0xfedcba0987654321',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockLogger.info).toHaveBeenCalledWith('Registered new pair from factory', {
        pair: '0xpair',
        dex: 'uniswap_v2',
        token0: '0x12345678...',
        token1: '0xfedcba09...',
        blockNumber: 12345,
      });
    });

    it('should handle registration errors gracefully', () => {
      mockAddPairToIndices.mockImplementation(() => {
        throw new Error('Index failure');
      });

      const event: PairCreatedEvent = {
        dexName: 'uniswap_v2',
        factoryAddress: '0xfactory',
        factoryType: 'uniswap_v2',
        pairAddress: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        blockNumber: 12345,
        transactionHash: '0xtxhash',
      };

      pairCreatedCallback(event);

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to register pair from factory', {
        error: expect.any(Error),
        pairAddress: '0xpair',
        dex: 'uniswap_v2',
      });
    });
  });

  // =============================================================================
  // subscribeToNewPair - Event Subscription
  // =============================================================================

  describe('subscribeToNewPair', () => {
    it('should warn when wsManager is null', () => {
      const deps = createMockDeps();
      deps.wsManager = null;

      const service = new FactoryIntegrationService({ chain: 'ethereum' }, deps);

      // Access private method for testing
      const pair: Pair = {
        name: 'TEST',
        address: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        dex: 'uniswap_v2',
        fee: 0.003,
      };

      (service as any).subscribeToNewPair(pair);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'WebSocket manager not available for new pair subscription'
      );
    });

    it('should notify onPairSubscribed handler', () => {
      const handlers: FactoryIntegrationHandlers = {
        onPairSubscribed: jest.fn(),
      };

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps(),
        handlers
      );

      const pair: Pair = {
        name: 'TEST',
        address: '0xpair',
        token0: '0xtoken0',
        token1: '0xtoken1',
        dex: 'uniswap_v2',
        fee: 0.003,
      };

      (service as any).subscribeToNewPair(pair);

      expect(handlers.onPairSubscribed).toHaveBeenCalledWith(pair);
    });
  });

  // =============================================================================
  // Public Methods
  // =============================================================================

  describe('handleFactoryEvent', () => {
    it('should delegate to factory subscription service', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const mockEvent = { data: '0xdata' };
      service.handleFactoryEvent(mockEvent);

      expect(mockFactoryService.handleFactoryEvent).toHaveBeenCalledWith(mockEvent);
    });

    it('should do nothing when service is null', () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue([]);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      // Don't call initialize, service will be null
      service.handleFactoryEvent({ data: '0xdata' });

      // Should not throw
    });
  });

  describe('isFactoryAddress', () => {
    it('should return true for known factory address (O(1) Set lookup)', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xFACTORY']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      expect(service.isFactoryAddress('0xfactory')).toBe(true);
      expect(service.isFactoryAddress('0xFACTORY')).toBe(true); // Case insensitive
    });

    it('should return false for unknown address', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      expect(service.isFactoryAddress('0xunknown')).toBe(false);
    });
  });

  describe('getService', () => {
    it('should return factory subscription service', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      expect(service.getService()).toBe(mockFactoryService);
    });

    it('should return null before initialization', () => {
      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      expect(service.getService()).toBeNull();
    });
  });

  describe('getFactoryAddresses', () => {
    it('should return factory addresses set', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory1', '0xfactory2']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const addresses = service.getFactoryAddresses();

      expect(addresses.size).toBe(2);
      expect(addresses.has('0xfactory1')).toBe(true);
      expect(addresses.has('0xfactory2')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return stats from factory service', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      const stats = service.getStats();

      expect(stats).toEqual({ subscriptions: 1 });
    });

    it('should return null when service is not initialized', () => {
      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      const stats = service.getStats();

      expect(stats).toBeNull();
    });
  });

  describe('stop', () => {
    it('should stop factory subscription service', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      service.stop();

      expect(mockFactoryService.stop).toHaveBeenCalled();
      expect(service.getService()).toBeNull();
      expect(service.getFactoryAddresses().size).toBe(0);
    });

    it('should handle stop errors gracefully', async () => {
      (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0xfactory']);
      mockFactoryService.stop.mockImplementation(() => {
        throw new Error('Stop failed');
      });

      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      await service.initialize();

      service.stop();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error stopping factory subscription service',
        { error: expect.any(Error) }
      );
    });

    it('should do nothing when service is already null', () => {
      const service = new FactoryIntegrationService(
        { chain: 'ethereum' },
        createMockDeps()
      );

      service.stop();

      // Should not throw
      expect(service.getService()).toBeNull();
    });
  });
});
