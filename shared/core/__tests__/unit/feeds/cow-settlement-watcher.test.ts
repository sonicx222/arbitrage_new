/**
 * CowSettlementWatcher Tests
 *
 * Tests for the CoW Protocol settlement watcher that monitors
 * GPv2Settlement contract Trade events on Ethereum.
 *
 * @see shared/core/src/feeds/cow-settlement-watcher.ts
 * @see Phase 4 Task 22: CoW settlement watcher
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Setup - Must be before imports that use these modules
// =============================================================================

jest.mock('../../../src/logger');

// =============================================================================
// Imports - After mocks
// =============================================================================

import {
  CowSettlementWatcher,
  GPV2_SETTLEMENT_ADDRESS,
} from '../../../src/feeds/cow-settlement-watcher';
import type {
  CowSettlement,
  CowWatcherConfig,
} from '../../../src/feeds/cow-settlement-watcher';

// =============================================================================
// Mock Helpers
// =============================================================================

/**
 * Create a mock trade event log matching ethers v6 EventLog shape.
 */
function createMockTradeEvent(overrides: {
  txHash?: string;
  blockNumber?: number;
  owner?: string;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: bigint;
  buyAmount?: bigint;
  feeAmount?: bigint;
  orderUid?: string;
} = {}) {
  return {
    transactionHash: overrides.txHash ?? '0xabc123',
    blockNumber: overrides.blockNumber ?? 100,
    args: [
      overrides.owner ?? '0xOwner1',
      overrides.sellToken ?? '0xWETH',
      overrides.buyToken ?? '0xUSDC',
      overrides.sellAmount ?? 10000000000000000000n, // 10 WETH
      overrides.buyAmount ?? 25000000000n,           // 25000 USDC (6 decimals)
      overrides.feeAmount ?? 100000000000000000n,     // 0.1 WETH fee
      overrides.orderUid ?? '0xOrderUid1',
    ],
  };
}

/**
 * Create a mock Settlement event log.
 */
function createMockSettlementEvent(overrides: {
  txHash?: string;
  solver?: string;
} = {}) {
  return {
    transactionHash: overrides.txHash ?? '0xabc123',
    args: [
      overrides.solver ?? '0xSolver1',
    ],
  };
}

/**
 * Create a mock ethers v6 provider.
 */
function createMockProvider(currentBlock = 100) {
  return {
    getBlockNumber: jest.fn<() => Promise<number>>().mockResolvedValue(currentBlock),
  };
}

/**
 * Create a mock ethers v6 Contract with queryFilter and filters.
 */
function createMockContract(tradeEvents: unknown[] = [], settlementEvents: unknown[] = []) {
  const mockQueryFilter = jest.fn<(filter: unknown, fromBlock?: number, toBlock?: number) => Promise<unknown[]>>();

  // First call = Trade events, second call = Settlement events
  mockQueryFilter
    .mockResolvedValueOnce(tradeEvents)
    .mockResolvedValueOnce(settlementEvents);

  return {
    filters: {
      Trade: jest.fn().mockReturnValue('trade-filter'),
      Settlement: jest.fn().mockReturnValue('settlement-filter'),
    },
    queryFilter: mockQueryFilter,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('CowSettlementWatcher', () => {
  let watcher: CowSettlementWatcher;

  beforeEach(() => {
    watcher = new CowSettlementWatcher({ minTrades: 1 });
    // Add default error listener to prevent unhandled error throws
    watcher.on('error', () => {});
  });

  afterEach(async () => {
    await watcher.stop();
    watcher.removeAllListeners();
  });

  // ===========================================================================
  // Constructor & Configuration
  // ===========================================================================

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const defaultWatcher = new CowSettlementWatcher();
      expect(defaultWatcher.isActive()).toBe(false);
    });

    it('should accept custom config', () => {
      const customWatcher = new CowSettlementWatcher({
        minTrades: 5,
        pollIntervalMs: 6000,
        lookbackBlocks: 3,
      });
      expect(customWatcher.isActive()).toBe(false);
    });
  });

  // ===========================================================================
  // Start/Stop Lifecycle
  // ===========================================================================

  describe('start()', () => {
    it('should set isActive to true', async () => {
      const provider = createMockProvider(100);

      await watcher.start(provider as any);

      expect(watcher.isActive()).toBe(true);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
    });

    it('should not start twice', async () => {
      const provider = createMockProvider(100);

      await watcher.start(provider as any);
      await watcher.start(provider as any); // duplicate

      // getBlockNumber should only be called once (from first start)
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
    });

    it('should emit error if provider.getBlockNumber fails', async () => {
      const provider = {
        getBlockNumber: jest.fn<() => Promise<number>>().mockRejectedValue(new Error('RPC down')),
      };

      const errorHandler = jest.fn();
      watcher.on('error', errorHandler);

      await watcher.start(provider as any);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'RPC down' }),
      );
      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('stop()', () => {
    it('should set isActive to false', async () => {
      const provider = createMockProvider(100);
      await watcher.start(provider as any);

      await watcher.stop();

      expect(watcher.isActive()).toBe(false);
    });

    it('should handle stop when not started', async () => {
      // Should not throw
      await watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('isActive()', () => {
    it('should return false before start', () => {
      expect(watcher.isActive()).toBe(false);
    });

    it('should return true after start', async () => {
      const provider = createMockProvider(100);
      await watcher.start(provider as any);
      expect(watcher.isActive()).toBe(true);
    });

    it('should return false after stop', async () => {
      const provider = createMockProvider(100);
      await watcher.start(provider as any);
      await watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });
  });

  // ===========================================================================
  // Trade Event Parsing
  // ===========================================================================

  describe('pollRecentBlocks()', () => {
    it('should parse Trade events into CowTrade objects', async () => {
      const tradeEvents = [
        createMockTradeEvent({
          txHash: '0xtx1',
          owner: '0xAlice',
          sellToken: '0xWETH',
          buyToken: '0xDAI',
          sellAmount: 5000000000000000000n, // 5 WETH
          buyAmount: 12500000000000000000000n, // 12500 DAI
          feeAmount: 50000000000000000n,
          orderUid: '0xOrder1',
        }),
      ];
      const settlementEvents = [
        createMockSettlementEvent({ txHash: '0xtx1', solver: '0xSolverA' }),
      ];

      const mockContract = createMockContract(tradeEvents, settlementEvents);
      // Inject mock contract via starting and overriding
      const provider = createMockProvider(100);
      await watcher.start(provider as any);

      // Replace contract with mock
      (watcher as any).contract = mockContract;

      const settlements = await watcher.pollRecentBlocks(99, 100);

      expect(settlements).toHaveLength(1);
      expect(settlements[0].trades).toHaveLength(1);

      const trade = settlements[0].trades[0];
      expect(trade.owner).toBe('0xAlice');
      expect(trade.sellToken).toBe('0xWETH');
      expect(trade.buyToken).toBe('0xDAI');
      expect(trade.sellAmount).toBe(5000000000000000000n);
      expect(trade.buyAmount).toBe(12500000000000000000000n);
      expect(trade.feeAmount).toBe(50000000000000000n);
      expect(trade.orderUid).toBe('0xOrder1');
    });

    it('should group trades by txHash into settlements', async () => {
      const tradeEvents = [
        createMockTradeEvent({ txHash: '0xtx1', owner: '0xAlice', orderUid: '0xOrder1' }),
        createMockTradeEvent({ txHash: '0xtx1', owner: '0xBob', orderUid: '0xOrder2' }),
        createMockTradeEvent({ txHash: '0xtx2', owner: '0xCharlie', orderUid: '0xOrder3' }),
      ];
      const settlementEvents = [
        createMockSettlementEvent({ txHash: '0xtx1', solver: '0xSolverA' }),
        createMockSettlementEvent({ txHash: '0xtx2', solver: '0xSolverB' }),
      ];

      const mockContract = createMockContract(tradeEvents, settlementEvents);
      const provider = createMockProvider(100);
      await watcher.start(provider as any);
      (watcher as any).contract = mockContract;

      const settlements = await watcher.pollRecentBlocks(99, 100);

      expect(settlements).toHaveLength(2);

      const tx1Settlement = settlements.find(s => s.txHash === '0xtx1');
      const tx2Settlement = settlements.find(s => s.txHash === '0xtx2');

      expect(tx1Settlement).toBeDefined();
      expect(tx1Settlement!.trades).toHaveLength(2);
      expect(tx1Settlement!.solver).toBe('0xSolverA');

      expect(tx2Settlement).toBeDefined();
      expect(tx2Settlement!.trades).toHaveLength(1);
      expect(tx2Settlement!.solver).toBe('0xSolverB');
    });

    it('should filter by minTrades threshold', async () => {
      // Create watcher with minTrades = 2
      const strictWatcher = new CowSettlementWatcher({ minTrades: 2 });
      strictWatcher.on('error', () => {});

      const tradeEvents = [
        // tx1 has only 1 trade (should be filtered)
        createMockTradeEvent({ txHash: '0xtx1', owner: '0xAlice' }),
        // tx2 has 2 trades (should pass)
        createMockTradeEvent({ txHash: '0xtx2', owner: '0xBob' }),
        createMockTradeEvent({ txHash: '0xtx2', owner: '0xCharlie' }),
      ];
      const settlementEvents = [
        createMockSettlementEvent({ txHash: '0xtx1', solver: '0xSolverA' }),
        createMockSettlementEvent({ txHash: '0xtx2', solver: '0xSolverB' }),
      ];

      const mockContract = createMockContract(tradeEvents, settlementEvents);
      const provider = createMockProvider(100);
      await strictWatcher.start(provider as any);
      (strictWatcher as any).contract = mockContract;

      const settlements = await strictWatcher.pollRecentBlocks(99, 100);

      expect(settlements).toHaveLength(1);
      expect(settlements[0].txHash).toBe('0xtx2');
      expect(settlements[0].trades).toHaveLength(2);

      await strictWatcher.stop();
    });

    it('should return empty array when no events found', async () => {
      const mockContract = createMockContract([], []);
      const provider = createMockProvider(100);
      await watcher.start(provider as any);
      (watcher as any).contract = mockContract;

      const settlements = await watcher.pollRecentBlocks(99, 100);

      expect(settlements).toHaveLength(0);
    });

    it('should return empty array when contract is null', async () => {
      // Don't start the watcher, so contract is null
      const settlements = await watcher.pollRecentBlocks(99, 100);
      expect(settlements).toHaveLength(0);
    });

    it('should set solver to unknown when Settlement event is missing', async () => {
      const tradeEvents = [
        createMockTradeEvent({ txHash: '0xtx1' }),
      ];
      // No settlement events for this tx
      const mockContract = createMockContract(tradeEvents, []);
      const provider = createMockProvider(100);
      await watcher.start(provider as any);
      (watcher as any).contract = mockContract;

      const settlements = await watcher.pollRecentBlocks(99, 100);

      expect(settlements).toHaveLength(1);
      expect(settlements[0].solver).toBe('unknown');
    });

    it('should skip events without args', async () => {
      const tradeEvents = [
        { transactionHash: '0xtx1', blockNumber: 100 }, // no args
        createMockTradeEvent({ txHash: '0xtx1' }),
      ];
      const settlementEvents = [
        createMockSettlementEvent({ txHash: '0xtx1' }),
      ];

      const mockContract = createMockContract(tradeEvents, settlementEvents);
      const provider = createMockProvider(100);
      await watcher.start(provider as any);
      (watcher as any).contract = mockContract;

      const settlements = await watcher.pollRecentBlocks(99, 100);

      expect(settlements).toHaveLength(1);
      expect(settlements[0].trades).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Polling Loop
  // ===========================================================================

  describe('poll()', () => {
    it('should skip if no new blocks since last poll', async () => {
      const provider = createMockProvider(100);
      await watcher.start(provider as any);

      // lastProcessedBlock is set to 100 during start()
      // getBlockNumber returns 100 on poll() too — no new blocks
      const settlementHandler = jest.fn();
      watcher.on('settlement', settlementHandler);

      await watcher.poll();

      expect(settlementHandler).not.toHaveBeenCalled();
    });

    it('should emit settlement events when new blocks have settlements', async () => {
      const provider = createMockProvider(100);
      await watcher.start(provider as any);

      // Advance block number for the poll
      (provider.getBlockNumber as jest.Mock<() => Promise<number>>).mockResolvedValue(102);

      // Set up mock contract with events
      const tradeEvents = [
        createMockTradeEvent({ txHash: '0xtx1' }),
      ];
      const settlementEvents = [
        createMockSettlementEvent({ txHash: '0xtx1' }),
      ];
      const mockContract = createMockContract(tradeEvents, settlementEvents);
      (watcher as any).contract = mockContract;

      const settlementHandler = jest.fn<(s: CowSettlement) => void>();
      watcher.on('settlement', settlementHandler);

      await watcher.poll();

      expect(settlementHandler).toHaveBeenCalledTimes(1);
      expect(settlementHandler.mock.calls[0][0].txHash).toBe('0xtx1');
    });

    it('should emit error on provider failure during poll', async () => {
      const provider = createMockProvider(100);
      await watcher.start(provider as any);

      // Make getBlockNumber fail on next call
      (provider.getBlockNumber as jest.Mock<() => Promise<number>>).mockRejectedValue(
        new Error('Provider disconnected'),
      );

      const errorHandler = jest.fn();
      watcher.on('error', errorHandler);

      await watcher.poll();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Provider disconnected' }),
      );
    });

    it('should not poll when contract is null (not started)', async () => {
      // poll without starting — should be a no-op
      const settlementHandler = jest.fn();
      watcher.on('settlement', settlementHandler);

      await watcher.poll();

      expect(settlementHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Constants
  // ===========================================================================

  describe('constants', () => {
    it('should export correct GPv2Settlement address', () => {
      expect(GPV2_SETTLEMENT_ADDRESS).toBe('0x9008D19f58AAbD9eD0D60971565AA8510560ab41');
    });
  });
});
