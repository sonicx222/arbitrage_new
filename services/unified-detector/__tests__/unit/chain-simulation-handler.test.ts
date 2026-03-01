/**
 * Unit Tests for ChainSimulationHandler
 *
 * Tests the simulation module for EVM and non-EVM chain simulation.
 * Validates callbacks, lifecycle management, and event generation.
 */

import { EventEmitter } from 'events';
import {
  ChainSimulationHandler,
  SimulationCallbacks,
  PairForSimulation,
  NonEvmSimulationConfig
} from '../../src/simulation';
import { Logger } from '../../src/types';
import { PriceUpdate, ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock Setup
// =============================================================================

// FIX: Mock chain simulator - create fresh instance in each test
let mockChainSimulatorEmitter: EventEmitter & { start: jest.Mock; stop: jest.Mock };

// Create a fresh mock simulator
const createMockSimulator = () => {
  const emitter = new EventEmitter() as EventEmitter & { start: jest.Mock; stop: jest.Mock };
  emitter.start = jest.fn();
  emitter.stop = jest.fn();
  return emitter;
};

// The source imports from sub-entry points:
// - @arbitrage/core/simulation (getChainSimulator, stopChainSimulator)
// - @arbitrage/core/async (clearIntervalSafe)
// Mock each sub-entry point separately.
jest.mock('@arbitrage/core/simulation', () => {
  return {
    getChainSimulator: jest.fn(),
    stopChainSimulator: jest.fn(),
  };
});

jest.mock('@arbitrage/core/async', () => {
  return {
    clearIntervalSafe: jest.fn().mockReturnValue(null),
  };
});

// Helper to get the mock chain simulator
const getMockChainSimulator = () => mockChainSimulatorEmitter;

// Create mock logger
const createMockLogger = (): Logger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

// Create mock callbacks
const createMockCallbacks = (): SimulationCallbacks & { mocks: Record<string, jest.Mock> } => {
  const onPriceUpdate = jest.fn();
  const onOpportunity = jest.fn();
  const onBlockUpdate = jest.fn();
  const onEventProcessed = jest.fn();
  const onSyncEvent = jest.fn();

  return {
    onPriceUpdate,
    onOpportunity,
    onBlockUpdate,
    onEventProcessed,
    onSyncEvent,
    mocks: {
      onPriceUpdate,
      onOpportunity,
      onBlockUpdate,
      onEventProcessed,
      onSyncEvent,
    }
  };
};

// Sample pairs for simulation
const createSamplePairs = (): PairForSimulation[] => [
  {
    key: 'uniswap_WETH_USDC',
    address: '0x1234567890123456789012345678901234567890',
    dex: 'uniswap',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Decimals: 18,
    token1Decimals: 6,
    fee: 0.003
  },
  {
    key: 'sushiswap_WETH_USDC',
    address: '0x0987654321098765432109876543210987654321',
    dex: 'sushiswap',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Decimals: 18,
    token1Decimals: 6,
    fee: 0.003
  }
];

// =============================================================================
// Tests
// =============================================================================

describe('ChainSimulationHandler', () => {
  let handler: ChainSimulationHandler;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ legacyFakeTimers: false });
    // Use low realism for predictable test behavior
    process.env.SIMULATION_REALISM_LEVEL = 'low';

    // FIX: Create fresh mock simulator for each test and reset the mock implementation
    mockChainSimulatorEmitter = createMockSimulator();
    const { getChainSimulator } = require('@arbitrage/core/simulation');
    (getChainSimulator as jest.Mock).mockReturnValue(mockChainSimulatorEmitter);

    logger = createMockLogger();
    handler = new ChainSimulationHandler('ethereum', logger);
  });

  afterEach(async () => {
    await handler.stop();
    jest.useRealTimers();
    delete process.env.SIMULATION_REALISM_LEVEL;
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create handler with chain ID and logger', () => {
      expect(handler).toBeDefined();
      expect(handler.isActive()).toBe(false);
    });
  });

  // ===========================================================================
  // EVM Simulation
  // ===========================================================================

  describe('initializeEvmSimulation', () => {
    it('should initialize EVM simulation with pairs and callbacks', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      expect(handler.isActive()).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Initializing EVM simulation mode',
        expect.objectContaining({ chainId: 'ethereum', pairs: 2 })
      );
    });

    it('should warn and return early if no pairs provided', async () => {
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation([], callbacks);

      expect(logger.warn).toHaveBeenCalledWith(
        'No pairs available for simulation',
        expect.objectContaining({ chainId: 'ethereum' })
      );
      expect(handler.isActive()).toBe(false);
    });

    it('should start the chain simulator', async () => {
      const { getChainSimulator } = require('@arbitrage/core/simulation');
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      expect(getChainSimulator).toHaveBeenCalledWith('ethereum', expect.any(Array));
      expect(getMockChainSimulator().start).toHaveBeenCalled();
    });

    it('should call onBlockUpdate callback on blockUpdate event', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      // Emit block update from mock simulator
      getMockChainSimulator().emit('blockUpdate', { blockNumber: 12345678 });

      expect(callbacks.mocks.onBlockUpdate).toHaveBeenCalledWith(12345678);
    });

    it('should call onOpportunity callback on opportunity event', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      const mockOpportunity: ArbitrageOpportunity = {
        id: 'opp-123',
        type: 'simple',
        chain: 'ethereum',
        buyDex: 'uniswap',
        sellDex: 'sushiswap',
        buyPair: 'uniswap_WETH_USDC',
        sellPair: 'sushiswap_WETH_USDC',
        token0: 'WETH',
        token1: 'USDC',
        tokenIn: 'WETH',
        tokenOut: 'USDC',
        amountIn: '1000000000000000000',
        buyPrice: 3000,
        sellPrice: 3010,
        profitPercentage: 0.33,
        expectedProfit: 10,
        confidence: 0.9,
        timestamp: Date.now(),
        expiresAt: Date.now() + 5000,
        status: 'pending'
      };

      getMockChainSimulator().emit('opportunity', mockOpportunity);

      expect(callbacks.mocks.onOpportunity).toHaveBeenCalledWith(mockOpportunity);
    });

    it('should call onSyncEvent callback with decoded reserves on syncEvent', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      // Create a valid sync event with encoded reserves
      // reserve0: 1000000000000000000 (1e18) -> hex padded to 64 chars
      // reserve1: 3000000000 (3e9) -> hex padded to 64 chars
      const reserve0Hex = BigInt('1000000000000000000').toString(16).padStart(64, '0');
      const reserve1Hex = BigInt('3000000000').toString(16).padStart(64, '0');
      const eventData = `0x${reserve0Hex}${reserve1Hex}`;
      const blockNumberHex = '0x' + (12345678).toString(16);

      getMockChainSimulator().emit('syncEvent', {
        address: '0x1234567890123456789012345678901234567890',
        data: eventData,
        blockNumber: blockNumberHex
      });

      expect(callbacks.mocks.onSyncEvent).toHaveBeenCalledWith({
        address: '0x1234567890123456789012345678901234567890',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        blockNumber: 12345678
      });
      expect(callbacks.mocks.onEventProcessed).toHaveBeenCalled();
    });

    it('should not process events when stopping', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);
      await handler.stop();

      getMockChainSimulator().emit('blockUpdate', { blockNumber: 12345678 });

      expect(callbacks.mocks.onBlockUpdate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Non-EVM Simulation
  // ===========================================================================

  describe('initializeNonEvmSimulation', () => {
    it('should initialize non-EVM simulation with config and callbacks', async () => {
      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: ['raydium', 'orca'],
        tokens: ['SOL', 'USDC', 'RAY'],
        updateIntervalMs: 500,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      // Create new handler for Solana
      const solanaHandler = new ChainSimulationHandler('solana', logger);

      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      expect(solanaHandler.isActive()).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Non-EVM simulation initialized',
        expect.objectContaining({
          chainId: 'solana',
          dexes: ['raydium', 'orca'],
          tokens: ['SOL', 'USDC', 'RAY']
        })
      );

      solanaHandler.stop();
    });

    it('should use default tokens and dexes if not provided', async () => {
      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: [],
        tokens: [],
        updateIntervalMs: 500,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      const solanaHandler = new ChainSimulationHandler('solana', logger);
      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      expect(logger.info).toHaveBeenCalledWith(
        'Non-EVM simulation initialized',
        expect.objectContaining({
          dexes: ['raydium', 'orca'],
          tokens: ['SOL', 'USDC', 'RAY', 'JUP']
        })
      );

      solanaHandler.stop();
    });

    it('should generate price updates at specified interval', async () => {
      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: ['raydium'],
        tokens: ['SOL', 'USDC'],
        updateIntervalMs: 100,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      const solanaHandler = new ChainSimulationHandler('solana', logger);
      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      // Advance timer to trigger update
      jest.advanceTimersByTime(100);

      expect(callbacks.mocks.onBlockUpdate).toHaveBeenCalled();
      expect(callbacks.mocks.onPriceUpdate).toHaveBeenCalled();
      expect(callbacks.mocks.onEventProcessed).toHaveBeenCalled();

      // Verify price update structure
      const priceUpdate = callbacks.mocks.onPriceUpdate.mock.calls[0][0] as PriceUpdate;
      expect(priceUpdate.chain).toBe('solana');
      expect(priceUpdate.dex).toBe('raydium');
      expect(priceUpdate.pairKey).toBe('raydium_SOL_USDC');
      expect(typeof priceUpdate.price).toBe('number');

      solanaHandler.stop();
    });

    it('should occasionally generate arbitrage opportunities', async () => {
      // Mock Math.random to always force opportunity generation
      // The opportunity check requires random < 0.03, so we use 0.01 for all calls
      const originalRandom = Math.random;
      let callCount = 0;
      Math.random = jest.fn().mockImplementation(() => {
        callCount++;
        // Return low values that trigger opportunity generation
        // This ensures any opportunity check (random < 0.03) passes
        return 0.01;
      });

      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: ['raydium', 'orca'],
        tokens: ['SOL', 'USDC'],
        updateIntervalMs: 100,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      const solanaHandler = new ChainSimulationHandler('solana', logger);
      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      // Advance timer and allow microtasks to complete
      jest.advanceTimersByTime(100);
      await Promise.resolve();

      // Restore Math.random
      Math.random = originalRandom;

      // Check if opportunity was generated
      expect(callbacks.mocks.onOpportunity).toHaveBeenCalled();

      const opportunity = callbacks.mocks.onOpportunity.mock.calls[0][0] as ArbitrageOpportunity;
      expect(opportunity.chain).toBe('solana');
      expect(opportunity.type).toBe('solana');
      expect(opportunity.tokenIn).toBe('SOL');
      expect(opportunity.tokenOut).toBe('USDC');
      expect(opportunity.amountIn).toBe('1000000000');
      expect(typeof opportunity.expectedProfit).toBe('number');
      expect(opportunity.expectedProfit).toBeGreaterThan(0);

      solanaHandler.stop();
    });

    it('should not generate updates when stopping', async () => {
      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: ['raydium'],
        tokens: ['SOL', 'USDC'],
        updateIntervalMs: 100,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      const solanaHandler = new ChainSimulationHandler('solana', logger);
      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      solanaHandler.stop();

      // Clear any calls from initialization
      callbacks.mocks.onPriceUpdate.mockClear();
      callbacks.mocks.onBlockUpdate.mockClear();

      // Advance timer - should not generate updates
      jest.advanceTimersByTime(200);

      expect(callbacks.mocks.onPriceUpdate).not.toHaveBeenCalled();
      expect(callbacks.mocks.onBlockUpdate).not.toHaveBeenCalled();
    });

    it('should increment slot number on each update', async () => {
      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: ['raydium'],
        tokens: ['SOL', 'USDC'],
        updateIntervalMs: 100,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      const solanaHandler = new ChainSimulationHandler('solana', logger);
      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      jest.advanceTimersByTime(100);
      const firstBlock = callbacks.mocks.onBlockUpdate.mock.calls[0][0];

      jest.advanceTimersByTime(100);
      const secondBlock = callbacks.mocks.onBlockUpdate.mock.calls[1][0];

      expect(secondBlock).toBe(firstBlock + 1);

      solanaHandler.stop();
    });
  });

  // ===========================================================================
  // Stop
  // ===========================================================================

  describe('stop', () => {
    it('should stop EVM simulation and cleanup', async () => {
      const { stopChainSimulator } = require('@arbitrage/core/simulation');
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);
      expect(handler.isActive()).toBe(true);

      await handler.stop();

      expect(handler.isActive()).toBe(false);
      expect(getMockChainSimulator().stop).toHaveBeenCalled();
      expect(stopChainSimulator).toHaveBeenCalledWith('ethereum');
      expect(logger.info).toHaveBeenCalledWith(
        'Simulation stopped',
        expect.objectContaining({ chainId: 'ethereum' })
      );
    });

    it('should stop non-EVM simulation interval', async () => {
      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: ['raydium'],
        tokens: ['SOL', 'USDC'],
        updateIntervalMs: 100,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      const solanaHandler = new ChainSimulationHandler('solana', logger);
      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      solanaHandler.stop();

      expect(solanaHandler.isActive()).toBe(false);
    });

    it('should be safe to call stop multiple times', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      // Stop multiple times - should not throw
      expect(() => {
        handler.stop();
        handler.stop();
        handler.stop();
      }).not.toThrow();
    });

    it('should be safe to call stop without initialization', () => {
      const newHandler = new ChainSimulationHandler('polygon', logger);

      // Stop without initializing - should not throw
      expect(() => {
        newHandler.stop();
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // isActive
  // ===========================================================================

  describe('isActive', () => {
    it('should return false before initialization', () => {
      expect(handler.isActive()).toBe(false);
    });

    it('should return true after EVM simulation initialization', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      expect(handler.isActive()).toBe(true);
    });

    it('should return true after non-EVM simulation initialization', async () => {
      const config: NonEvmSimulationConfig = {
        chainId: 'solana',
        dexes: ['raydium'],
        tokens: ['SOL', 'USDC'],
        updateIntervalMs: 100,
        volatility: 0.02,
        logger
      };
      const callbacks = createMockCallbacks();

      const solanaHandler = new ChainSimulationHandler('solana', logger);
      await solanaHandler.initializeNonEvmSimulation(config, callbacks);

      expect(solanaHandler.isActive()).toBe(true);

      solanaHandler.stop();
    });

    it('should return false after stop', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);
      handler.stop();

      expect(handler.isActive()).toBe(false);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should log error on invalid sync event data', async () => {
      const pairs = createSamplePairs();
      const callbacks = createMockCallbacks();

      await handler.initializeEvmSimulation(pairs, callbacks);

      // Emit invalid sync event with malformed data
      getMockChainSimulator().emit('syncEvent', {
        address: '0x1234567890123456789012345678901234567890',
        data: '0xINVALID',
        blockNumber: '0xbc614e'
      });

      expect(logger.error).toHaveBeenCalledWith(
        'Error processing simulated sync event',
        expect.any(Object)
      );
    });
  });
});
