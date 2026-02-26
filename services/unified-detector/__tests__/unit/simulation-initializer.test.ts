// @ts-nocheck
/**
 * SimulationInitializer Unit Tests
 *
 * Tests for the simulation lifecycle manager.
 * Verifies initialization, pair building, sync event handling,
 * and cleanup via constructor DI.
 *
 * @see simulation-initializer.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

const mockStopAndNullify = jest.fn().mockResolvedValue(null);
jest.mock('@arbitrage/core/async', () => ({
  stopAndNullify: mockStopAndNullify,
}));

jest.mock('@arbitrage/core/analytics', () => ({
  PairActivityTracker: jest.fn(),
}));

const mockInitializeEvmSimulation = jest.fn().mockResolvedValue(undefined);
const mockInitializeNonEvmSimulation = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn();

const MockChainSimulationHandler = jest.fn().mockImplementation(() => ({
  initializeEvmSimulation: mockInitializeEvmSimulation,
  initializeNonEvmSimulation: mockInitializeNonEvmSimulation,
  stop: mockStop,
}));

jest.mock('../../src/simulation', () => ({
  ChainSimulationHandler: MockChainSimulationHandler,
}));

jest.mock('../../src/detection', () => ({
  SnapshotManager: jest.fn(),
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { SimulationInitializer, createSimulationInitializer } from '../../src/simulation-initializer';
import type { SimulationInitializerDeps } from '../../src/simulation-initializer';
import type { ExtendedPair } from '../../src/types';
import {
  DEFAULT_SIMULATION_UPDATE_INTERVAL_MS,
  DEFAULT_SIMULATION_VOLATILITY,
  MIN_SIMULATION_UPDATE_INTERVAL_MS,
  MAX_SIMULATION_UPDATE_INTERVAL_MS,
  MIN_SIMULATION_VOLATILITY,
  MAX_SIMULATION_VOLATILITY,
} from '../../src/constants';

// =============================================================================
// Fixtures
// =============================================================================

const createMockDeps = (overrides: Partial<SimulationInitializerDeps> = {}): SimulationInitializerDeps => ({
  chainId: 'ethereum',
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  dexes: [
    { id: 'uniswap_v3', name: 'Uniswap V3', factory: '0xfactory1', router: '0xrouter1', fee: 0.003 },
    { id: 'sushiswap', name: 'SushiSwap', factory: '0xfactory2', router: '0xrouter2', fee: 0.003 },
  ],
  tokens: [
    { symbol: 'WETH', address: '0xweth', decimals: 18 },
    { symbol: 'USDC', address: '0xusdc', decimals: 6 },
  ],
  pairs: new Map(),
  tokensByAddress: new Map(),
  pairsByAddress: new Map(),
  activityTracker: { recordUpdate: jest.fn(), trackPairActivity: jest.fn(), getActivePairs: jest.fn().mockReturnValue([]) },
  snapshotManager: { takeSnapshot: jest.fn(), getLatestSnapshot: jest.fn(), invalidateCache: jest.fn() },
  emit: jest.fn(),
  emitPriceUpdate: jest.fn(),
  checkArbitrageOpportunity: jest.fn(),
  onOpportunityFound: jest.fn(),
  onEventProcessed: jest.fn(),
  onBlockUpdate: jest.fn(),
  ...overrides,
});

function createMockPair(overrides: Partial<ExtendedPair> = {}): ExtendedPair {
  return {
    address: '0xpair1',
    token0: '0xweth',
    token1: '0xusdc',
    dex: 'sushiswap',
    fee: 0.003,
    reserve0: '1000000000000000000',
    reserve1: '2000000000',
    blockNumber: 100,
    lastUpdate: Date.now(),
    pairKey: 'sushiswap_WETH_USDC',
    chainPairKey: 'ethereum:0xpair1',
    ...overrides,
  };
}

// =============================================================================
// Setup / Teardown
// =============================================================================

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = { ...process.env };
  // Clear simulation env vars so defaults apply
  delete process.env.SIMULATION_UPDATE_INTERVAL_MS;
  delete process.env.SIMULATION_VOLATILITY;

  // Re-establish mock implementations after clearAllMocks
  mockStopAndNullify.mockResolvedValue(null);
  mockInitializeEvmSimulation.mockResolvedValue(undefined);
  mockInitializeNonEvmSimulation.mockResolvedValue(undefined);
  MockChainSimulationHandler.mockImplementation(() => ({
    initializeEvmSimulation: mockInitializeEvmSimulation,
    initializeNonEvmSimulation: mockInitializeNonEvmSimulation,
    stop: mockStop,
  }));
});

afterEach(() => {
  process.env = savedEnv;
});

// =============================================================================
// Tests
// =============================================================================

describe('SimulationInitializer', () => {

  // ---------------------------------------------------------------------------
  // Constructor & Factory
  // ---------------------------------------------------------------------------

  describe('constructor & factory', () => {
    it('should create instance with valid deps', () => {
      const deps = createMockDeps();
      const initializer = new SimulationInitializer(deps);

      expect(initializer).toBeInstanceOf(SimulationInitializer);
      expect(initializer.getSimulationHandler()).toBeNull();
    });

    it('should create instance via createSimulationInitializer factory', () => {
      const deps = createMockDeps();
      const initializer = createSimulationInitializer(deps);

      expect(initializer).toBeInstanceOf(SimulationInitializer);
    });
  });

  // ---------------------------------------------------------------------------
  // buildPairsForSimulation (private, tested via initializeEvmSimulation)
  // ---------------------------------------------------------------------------

  describe('buildPairsForSimulation (via initializeEvmSimulation)', () => {
    it('should build pairs from pairs Map with correct format', async () => {
      // Use dex name without underscore so split('_') parsing is straightforward:
      // Key format: "dex_TOKEN0_TOKEN1" -> parts = ['sushiswap', 'WETH', 'USDC']
      const pair = createMockPair({ dex: 'sushiswap', pairKey: 'sushiswap_WETH_USDC' });
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const tokensByAddress = new Map([
        ['0xweth', { symbol: 'WETH', address: '0xweth', decimals: 18 }],
        ['0xusdc', { symbol: 'USDC', address: '0xusdc', decimals: 6 }],
      ]);

      const deps = createMockDeps({ pairs, tokensByAddress });
      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      // ChainSimulationHandler.initializeEvmSimulation should have been called with pairs
      expect(mockInitializeEvmSimulation).toHaveBeenCalledTimes(1);
      const pairsArg = mockInitializeEvmSimulation.mock.calls[0][0];
      expect(pairsArg).toHaveLength(1);
      expect(pairsArg[0]).toEqual(expect.objectContaining({
        key: 'sushiswap_WETH_USDC',
        address: '0xpair1',
        dex: 'sushiswap',
        token0Symbol: 'WETH',
        token1Symbol: 'USDC',
      }));
    });

    it('should use token decimals from tokensByAddress lookup', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const tokensByAddress = new Map([
        ['0xweth', { symbol: 'WETH', address: '0xweth', decimals: 18 }],
        ['0xusdc', { symbol: 'USDC', address: '0xusdc', decimals: 6 }],
      ]);

      const deps = createMockDeps({ pairs, tokensByAddress });
      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      const pairsArg = mockInitializeEvmSimulation.mock.calls[0][0];
      expect(pairsArg[0].token0Decimals).toBe(18);
      expect(pairsArg[0].token1Decimals).toBe(6);
    });

    it('should default to 18 decimals when token not found in tokensByAddress', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      // Empty tokensByAddress -- token lookup will miss
      const tokensByAddress = new Map();

      const deps = createMockDeps({ pairs, tokensByAddress });
      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      const pairsArg = mockInitializeEvmSimulation.mock.calls[0][0];
      expect(pairsArg[0].token0Decimals).toBe(18);
      expect(pairsArg[0].token1Decimals).toBe(18);
    });

    it('should skip pair keys with fewer than 3 underscore-separated parts', async () => {
      const pair = createMockPair();
      // Malformed key with only 2 parts
      const pairs = new Map([
        ['bad_key', pair],
        ['sushiswap_WETH_USDC', pair],
      ]);

      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      const pairsArg = mockInitializeEvmSimulation.mock.calls[0][0];
      expect(pairsArg).toHaveLength(1);
      expect(pairsArg[0].key).toBe('sushiswap_WETH_USDC');
    });

    it('should handle empty pairs Map gracefully', async () => {
      const deps = createMockDeps({ pairs: new Map() });
      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      // Should warn and return without calling handler.initializeEvmSimulation
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'No pairs available for simulation',
        expect.objectContaining({ chainId: 'ethereum' })
      );
      expect(mockInitializeEvmSimulation).not.toHaveBeenCalled();
    });

    it('should use pair.fee with fallback to 0.003', async () => {
      const pairWithFee = createMockPair({ fee: 0.01, dex: 'pancakeswap', pairKey: 'pancakeswap_WETH_USDC' });
      const pairWithoutFee = createMockPair({
        address: '0xpair2',
        fee: undefined,
        dex: 'sushiswap',
        pairKey: 'sushiswap_WETH_DAI',
      });

      const pairs = new Map([
        ['pancakeswap_WETH_USDC', pairWithFee],
        ['sushiswap_WETH_DAI', pairWithoutFee],
      ]);

      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      const pairsArg = mockInitializeEvmSimulation.mock.calls[0][0];
      const pancakePair = pairsArg.find((p: any) => p.key === 'pancakeswap_WETH_USDC');
      const sushiPair = pairsArg.find((p: any) => p.key === 'sushiswap_WETH_DAI');
      expect(pancakePair.fee).toBe(0.01);
      expect(sushiPair.fee).toBe(0.003);
    });
  });

  // ---------------------------------------------------------------------------
  // initializeEvmSimulation
  // ---------------------------------------------------------------------------

  describe('initializeEvmSimulation', () => {
    it('should create ChainSimulationHandler with chainId and logger', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      expect(MockChainSimulationHandler).toHaveBeenCalledWith('ethereum', deps.logger);
      expect(initializer.getSimulationHandler()).not.toBeNull();
    });

    it('should pass simulation callbacks to handler', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      expect(mockInitializeEvmSimulation).toHaveBeenCalledTimes(1);
      const callbacksArg = mockInitializeEvmSimulation.mock.calls[0][1];

      // Verify callback shape
      expect(callbacksArg).toEqual(expect.objectContaining({
        onPriceUpdate: expect.any(Function),
        onOpportunity: expect.any(Function),
        onBlockUpdate: expect.any(Function),
        onEventProcessed: expect.any(Function),
        onSyncEvent: expect.any(Function),
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // initializeNonEvmSimulation
  // ---------------------------------------------------------------------------

  describe('initializeNonEvmSimulation', () => {
    it('should create ChainSimulationHandler for non-EVM chain', async () => {
      const deps = createMockDeps({ chainId: 'solana' });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeNonEvmSimulation();

      expect(MockChainSimulationHandler).toHaveBeenCalledWith('solana', deps.logger);
      expect(initializer.getSimulationHandler()).not.toBeNull();
    });

    it('should pass dex names and token symbols to handler', async () => {
      const deps = createMockDeps({ chainId: 'solana' });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeNonEvmSimulation();

      expect(mockInitializeNonEvmSimulation).toHaveBeenCalledTimes(1);
      const configArg = mockInitializeNonEvmSimulation.mock.calls[0][0];

      expect(configArg).toEqual(expect.objectContaining({
        chainId: 'solana',
        dexes: ['Uniswap V3', 'SushiSwap'],
        tokens: ['WETH', 'USDC'],
      }));
    });

    it('should use default update interval and volatility when env vars unset', async () => {
      const deps = createMockDeps({ chainId: 'solana' });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeNonEvmSimulation();

      const configArg = mockInitializeNonEvmSimulation.mock.calls[0][0];
      expect(configArg.updateIntervalMs).toBe(DEFAULT_SIMULATION_UPDATE_INTERVAL_MS);
      expect(configArg.volatility).toBe(DEFAULT_SIMULATION_VOLATILITY);
    });

    it('should clamp update interval to min/max bounds', async () => {
      process.env.SIMULATION_UPDATE_INTERVAL_MS = '1'; // below min (100)
      const deps = createMockDeps({ chainId: 'solana' });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeNonEvmSimulation();

      const configArg = mockInitializeNonEvmSimulation.mock.calls[0][0];
      expect(configArg.updateIntervalMs).toBe(MIN_SIMULATION_UPDATE_INTERVAL_MS);
    });

    it('should clamp update interval to max bound', async () => {
      process.env.SIMULATION_UPDATE_INTERVAL_MS = '999999'; // above max (60000)
      const deps = createMockDeps({ chainId: 'solana' });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeNonEvmSimulation();

      const configArg = mockInitializeNonEvmSimulation.mock.calls[0][0];
      expect(configArg.updateIntervalMs).toBe(MAX_SIMULATION_UPDATE_INTERVAL_MS);
    });

    it('should clamp volatility to min/max bounds', async () => {
      process.env.SIMULATION_VOLATILITY = '5.0'; // above max (1.0)
      const deps = createMockDeps({ chainId: 'solana' });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeNonEvmSimulation();

      const configArg = mockInitializeNonEvmSimulation.mock.calls[0][0];
      expect(configArg.volatility).toBe(MAX_SIMULATION_VOLATILITY);
    });
  });

  // ---------------------------------------------------------------------------
  // Simulation Callbacks (tested by invoking them through the handler mock)
  // ---------------------------------------------------------------------------

  describe('simulation callbacks', () => {
    it('onPriceUpdate callback should emit priceUpdate event', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      const mockUpdate = { pairKey: 'test', price: 1.5 };
      callbacks.onPriceUpdate(mockUpdate);

      expect(deps.emit).toHaveBeenCalledWith('priceUpdate', mockUpdate);
    });

    it('onOpportunity callback should call onOpportunityFound and emit', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      const mockOpp = { id: 'opp-1', profitPercentage: 2.5 };
      callbacks.onOpportunity(mockOpp);

      expect(deps.onOpportunityFound).toHaveBeenCalledTimes(1);
      expect(deps.emit).toHaveBeenCalledWith('opportunity', mockOpp);
      expect(deps.logger.debug).toHaveBeenCalledWith(
        'Simulated opportunity detected',
        expect.objectContaining({ id: 'opp-1', profit: '2.50%' })
      );
    });

    it('onBlockUpdate callback should forward block number to deps', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      callbacks.onBlockUpdate(12345);

      expect(deps.onBlockUpdate).toHaveBeenCalledWith(12345);
    });

    it('onEventProcessed callback should forward to deps', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      callbacks.onEventProcessed();

      expect(deps.onEventProcessed).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // handleSimulatedSyncEvent (via onSyncEvent callback)
  // ---------------------------------------------------------------------------

  describe('handleSimulatedSyncEvent (via onSyncEvent callback)', () => {
    it('should update pair reserves and call emitPriceUpdate and checkArbitrageOpportunity', async () => {
      const pair = createMockPair({ address: '0xpair1' });
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const pairsByAddress = new Map([['0xpair1', pair]]);

      const deps = createMockDeps({ pairs, pairsByAddress });
      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      // Invoke the onSyncEvent callback
      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      callbacks.onSyncEvent({
        address: '0xPAIR1', // uppercase to test normalization
        reserve0: '5000000000000000000',
        reserve1: '10000000000',
        blockNumber: 200,
      });

      // Verify reserves were updated on the pair object
      expect(pair.reserve0).toBe('5000000000000000000');
      expect(pair.reserve1).toBe('10000000000');
      expect(pair.reserve0BigInt).toBe(BigInt('5000000000000000000'));
      expect(pair.reserve1BigInt).toBe(BigInt('10000000000'));
      expect(pair.blockNumber).toBe(200);

      // Verify callbacks
      expect(deps.emitPriceUpdate).toHaveBeenCalledWith(pair);
      expect(deps.checkArbitrageOpportunity).toHaveBeenCalledWith(pair);
      expect(deps.activityTracker.recordUpdate).toHaveBeenCalled();
      expect(deps.snapshotManager.invalidateCache).toHaveBeenCalled();
    });

    it('should skip unknown pair addresses silently', async () => {
      const deps = createMockDeps({ pairsByAddress: new Map() });
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      deps.pairs = pairs;

      const initializer = new SimulationInitializer(deps);
      await initializer.initializeEvmSimulation();

      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      callbacks.onSyncEvent({
        address: '0xunknown',
        reserve0: '100',
        reserve1: '200',
        blockNumber: 1,
      });

      expect(deps.emitPriceUpdate).not.toHaveBeenCalled();
      expect(deps.checkArbitrageOpportunity).not.toHaveBeenCalled();
    });

    it('should log error on invalid reserve values', async () => {
      const pair = createMockPair({ address: '0xpair1' });
      const pairsByAddress = new Map([['0xpair1', pair]]);
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs, pairsByAddress });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      callbacks.onSyncEvent({
        address: '0xpair1',
        reserve0: 'not-a-number', // invalid BigInt
        reserve1: '200',
        blockNumber: 1,
      });

      expect(deps.logger.error).toHaveBeenCalledWith(
        'Error processing simulated sync event',
        expect.objectContaining({ pairAddress: '0xpair1' })
      );
      // Should NOT have updated pair or called downstream
      expect(deps.emitPriceUpdate).not.toHaveBeenCalled();
    });

    it('should use chainPairKey for activity tracker if available', async () => {
      const pair = createMockPair({ address: '0xpair1', chainPairKey: 'ethereum:0xpair1' });
      const pairsByAddress = new Map([['0xpair1', pair]]);
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs, pairsByAddress });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      const callbacks = mockInitializeEvmSimulation.mock.calls[0][1];
      callbacks.onSyncEvent({
        address: '0xpair1',
        reserve0: '100',
        reserve1: '200',
        blockNumber: 1,
      });

      expect(deps.activityTracker.recordUpdate).toHaveBeenCalledWith('ethereum:0xpair1');
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  describe('stop', () => {
    it('should call stopAndNullify with the simulation handler', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();
      const handler = initializer.getSimulationHandler();
      expect(handler).not.toBeNull();

      await initializer.stop();

      expect(mockStopAndNullify).toHaveBeenCalledWith(handler);
      expect(initializer.getSimulationHandler()).toBeNull();
    });

    it('should be safe to call when no simulation is running', async () => {
      const deps = createMockDeps();
      const initializer = new SimulationInitializer(deps);

      // No simulation started, handler is null
      await expect(initializer.stop()).resolves.not.toThrow();

      expect(mockStopAndNullify).toHaveBeenCalledWith(null);
    });
  });

  // ---------------------------------------------------------------------------
  // getSimulationHandler
  // ---------------------------------------------------------------------------

  describe('getSimulationHandler', () => {
    it('should return null before initialization', () => {
      const deps = createMockDeps();
      const initializer = new SimulationInitializer(deps);

      expect(initializer.getSimulationHandler()).toBeNull();
    });

    it('should return handler after initialization', async () => {
      const pair = createMockPair();
      const pairs = new Map([['sushiswap_WETH_USDC', pair]]);
      const deps = createMockDeps({ pairs });
      const initializer = new SimulationInitializer(deps);

      await initializer.initializeEvmSimulation();

      expect(initializer.getSimulationHandler()).not.toBeNull();
    });
  });
});
