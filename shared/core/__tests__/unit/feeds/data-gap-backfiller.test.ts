/**
 * DataGapBackfiller Tests
 *
 * Tests for the data gap backfill system that fetches missed blockchain
 * events via eth_getLogs after WebSocket reconnections.
 *
 * @see C3 - Data Gap Backfill (Terminal Analysis Consolidated Plan)
 * @see shared/core/src/feeds/data-gap-backfiller.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { DataGapBackfiller } from '../../../src/feeds/data-gap-backfiller';
import type {
  DataGapEvent,
  DataGapSource,
  DataGapBackfillerConfig,
  DataGapBackfillerLogger,
  EthLog,
} from '../../../src/feeds/data-gap-backfiller';

// =============================================================================
// Helpers
// =============================================================================

function createMockLogger(): jest.Mocked<DataGapBackfillerLogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * Creates a mock DataGapSource (mimics WebSocketManager).
 */
function createMockSource(): DataGapSource & EventEmitter {
  const emitter = new EventEmitter() as DataGapSource & EventEmitter;
  (emitter as any).sendRequest = jest.fn().mockResolvedValue([]);
  return emitter;
}

function createDataGapEvent(overrides: Partial<DataGapEvent> = {}): DataGapEvent {
  return {
    chainId: 'bsc',
    fromBlock: 1000,
    toBlock: 1050,
    missedBlocks: 51,
    url: 'wss://example.com/ws',
    ...overrides,
  };
}

function createMockLog(overrides: Partial<EthLog> = {}): EthLog {
  return {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    topics: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'],
    data: '0x0000000000000000000000000000000000000000000000000000000000000000',
    blockNumber: '0x3e8',
    transactionHash: '0xabcdef',
    transactionIndex: '0x0',
    blockHash: '0x123456',
    logIndex: '0x0',
    removed: false,
    ...overrides,
  };
}

/**
 * Wait for the microtask queue to flush.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// =============================================================================
// Tests
// =============================================================================

describe('DataGapBackfiller', () => {
  let backfiller: DataGapBackfiller;
  let mockLogger: jest.Mocked<DataGapBackfillerLogger>;
  let mockSource: DataGapSource & EventEmitter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockSource = createMockSource();
    backfiller = new DataGapBackfiller(mockLogger);
  });

  afterEach(() => {
    backfiller.detach();
  });

  // ===========================================================================
  // Constructor & Config
  // ===========================================================================

  describe('constructor', () => {
    it('should create with default config', () => {
      const bf = new DataGapBackfiller(mockLogger);
      expect(bf).toBeDefined();
      expect(bf.getStats().backfillsAttempted).toBe(0);
    });

    it('should accept custom config', () => {
      const config: DataGapBackfillerConfig = {
        maxBlockRange: 50,
        rateLimitMs: 5000,
        requestTimeoutMs: 15000,
      };
      const bf = new DataGapBackfiller(mockLogger, config);
      expect(bf).toBeDefined();
    });

    it('should use custom event topics when provided', () => {
      const customTopics = ['0xabc', '0xdef'];
      const bf = new DataGapBackfiller(mockLogger, { eventTopics: customTopics });
      bf.attach(mockSource);

      mockSource.emit('dataGap', createDataGapEvent());

      // Wait for async handler
      return flushMicrotasks().then(() => {
        expect((mockSource as any).sendRequest).toHaveBeenCalledWith(
          'eth_getLogs',
          expect.arrayContaining([expect.objectContaining({
            topics: [customTopics],
          })]),
          expect.any(Number)
        );
      });
    });
  });

  // ===========================================================================
  // attach() / detachSource() / detach()
  // ===========================================================================

  describe('attach()', () => {
    it('should subscribe to dataGap events on the source', () => {
      backfiller.attach(mockSource);
      expect(backfiller.getAttachedSourceCount()).toBe(1);
    });

    it('should not double-attach the same source', () => {
      backfiller.attach(mockSource);
      backfiller.attach(mockSource);
      expect(backfiller.getAttachedSourceCount()).toBe(1);
    });

    it('should attach multiple different sources', () => {
      const source2 = createMockSource();
      backfiller.attach(mockSource);
      backfiller.attach(source2);
      expect(backfiller.getAttachedSourceCount()).toBe(2);
    });
  });

  describe('detachSource()', () => {
    it('should remove listener from specific source', () => {
      backfiller.attach(mockSource);
      backfiller.detachSource(mockSource);
      expect(backfiller.getAttachedSourceCount()).toBe(0);
    });

    it('should be safe to detach a non-attached source', () => {
      const unattached = createMockSource();
      backfiller.detachSource(unattached);
      expect(backfiller.getAttachedSourceCount()).toBe(0);
    });
  });

  describe('detach()', () => {
    it('should remove all listeners and clean up', () => {
      const source2 = createMockSource();
      backfiller.attach(mockSource);
      backfiller.attach(source2);
      backfiller.detach();

      expect(backfiller.getAttachedSourceCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Data gap handling
  // ===========================================================================

  describe('handleDataGap', () => {
    it('should call eth_getLogs with correct parameters on data gap', async () => {
      backfiller.attach(mockSource);

      const gap = createDataGapEvent({ fromBlock: 1000, toBlock: 1050 });
      mockSource.emit('dataGap', gap);
      await flushMicrotasks();

      // Gap is 51 blocks (1000-1050), within maxBlockRange=100, so no capping
      expect((mockSource as any).sendRequest).toHaveBeenCalledWith(
        'eth_getLogs',
        [{
          fromBlock: '0x3e8',   // 1000
          toBlock: '0x41a',     // 1050
          topics: [expect.arrayContaining([
            expect.stringMatching(/^0x/), // SYNC, SWAP_V2, SWAP_V3
          ])],
        }],
        10000
      );
    });

    it('should emit recoveredLogs when logs are found', async () => {
      backfiller.attach(mockSource);

      const mockLogs = [createMockLog(), createMockLog({ blockNumber: '0x3e9' })];
      (mockSource as any).sendRequest.mockResolvedValueOnce(mockLogs);

      const recoveredPromise = new Promise<any>(resolve => {
        backfiller.on('recoveredLogs', resolve);
      });

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 1000, toBlock: 1050 }));
      const recovered = await recoveredPromise;

      expect(recovered.chainId).toBe('bsc');
      expect(recovered.logs).toHaveLength(2);
      expect(recovered.fromBlock).toBe(1000);
    });

    it('should NOT emit recoveredLogs when no logs found', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockResolvedValueOnce([]);

      const recoveredSpy = jest.fn();
      backfiller.on('recoveredLogs', recoveredSpy);

      mockSource.emit('dataGap', createDataGapEvent());
      await flushMicrotasks();

      expect(recoveredSpy).not.toHaveBeenCalled();
    });

    it('should emit backfillComplete on success', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockResolvedValueOnce([createMockLog()]);

      const completePromise = new Promise<any>(resolve => {
        backfiller.on('backfillComplete', resolve);
      });

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 1000, toBlock: 1010, missedBlocks: 11 }));
      const result = await completePromise;

      expect(result.chainId).toBe('bsc');
      expect(result.logsRecovered).toBe(1);
      expect(result.blocksBackfilled).toBe(11);
    });

    it('should emit backfillError on failure', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockRejectedValueOnce(new Error('RPC timeout'));

      const errorPromise = new Promise<any>(resolve => {
        backfiller.on('backfillError', resolve);
      });

      mockSource.emit('dataGap', createDataGapEvent());
      const errorResult = await errorPromise;

      expect(errorResult.chainId).toBe('bsc');
      expect(errorResult.error).toBeInstanceOf(Error);
      expect(errorResult.error.message).toBe('RPC timeout');
    });

    it('should handle non-array eth_getLogs response gracefully', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockResolvedValueOnce(null);

      const completePromise = new Promise<any>(resolve => {
        backfiller.on('backfillComplete', resolve);
      });

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 1000, toBlock: 1010 }));
      const result = await completePromise;

      expect(result.logsRecovered).toBe(0);
    });
  });

  // ===========================================================================
  // Block range capping
  // ===========================================================================

  describe('block range capping', () => {
    it('should cap block range to maxBlockRange (default 100)', async () => {
      backfiller.attach(mockSource);

      const gap = createDataGapEvent({ fromBlock: 1000, toBlock: 2000, missedBlocks: 1001 });
      mockSource.emit('dataGap', gap);
      await flushMicrotasks();

      // Should request blocks 1000-1099 (100 blocks), not 1000-2000
      expect((mockSource as any).sendRequest).toHaveBeenCalledWith(
        'eth_getLogs',
        [{
          fromBlock: '0x3e8',   // 1000
          toBlock: '0x44b',     // 1099 = 1000 + 100 - 1
          topics: expect.any(Array),
        }],
        expect.any(Number)
      );
    });

    it('should log warning when range is capped', async () => {
      backfiller.attach(mockSource);

      mockSource.emit('dataGap', createDataGapEvent({
        fromBlock: 1000,
        toBlock: 2000,
        missedBlocks: 1001,
      }));
      await flushMicrotasks();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Backfill range capped',
        expect.objectContaining({
          requestedBlocks: 1001,
          cappedBlocks: 100,
        })
      );
    });

    it('should use custom maxBlockRange', async () => {
      const bf = new DataGapBackfiller(mockLogger, { maxBlockRange: 50 });
      bf.attach(mockSource);

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 1000, toBlock: 2000, missedBlocks: 1001 }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledWith(
        'eth_getLogs',
        [{
          fromBlock: '0x3e8',   // 1000
          toBlock: '0x419',     // 1049 = 1000 + 50 - 1
          topics: expect.any(Array),
        }],
        expect.any(Number)
      );

      bf.detach();
    });

    it('should not cap when range is within maxBlockRange', async () => {
      backfiller.attach(mockSource);

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 1000, toBlock: 1010, missedBlocks: 11 }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledWith(
        'eth_getLogs',
        [{
          fromBlock: '0x3e8',   // 1000
          toBlock: '0x3f2',     // 1010
          topics: expect.any(Array),
        }],
        expect.any(Number)
      );

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Backfill range capped',
        expect.any(Object)
      );
    });
  });

  // ===========================================================================
  // Rate limiting
  // ===========================================================================

  describe('rate limiting', () => {
    it('should rate-limit backfills for the same chain', async () => {
      const bf = new DataGapBackfiller(mockLogger, { rateLimitMs: 10_000 });
      bf.attach(mockSource);

      // First backfill — should proceed
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledTimes(1);

      // Second backfill immediately — should be rate-limited
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledTimes(1); // Still 1
      expect(bf.getStats().backfillsRateLimited).toBe(1);

      bf.detach();
    });

    it('should NOT rate-limit different chains', async () => {
      backfiller.attach(mockSource);

      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'ethereum' }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledTimes(2);
    });

    it('should allow backfill after rate limit expires', async () => {
      const bf = new DataGapBackfiller(mockLogger, { rateLimitMs: 100 });
      bf.attach(mockSource);

      // First backfill
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      // Wait for rate limit to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Second backfill — should proceed
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledTimes(2);

      bf.detach();
    });
  });

  // ===========================================================================
  // Concurrency guard
  // ===========================================================================

  describe('concurrency guard', () => {
    it('should prevent concurrent backfills for the same chain', async () => {
      backfiller.attach(mockSource);

      // Make first request hang
      let resolveFirst: (value: EthLog[]) => void;
      (mockSource as any).sendRequest.mockReturnValueOnce(
        new Promise<EthLog[]>(resolve => { resolveFirst = resolve; })
      );

      // First backfill starts (hangs)
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      expect(backfiller.isBackfillActive('bsc')).toBe(true);

      // Second backfill for same chain — should be skipped
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledTimes(1);

      // Resolve first backfill
      resolveFirst!([]);
      await flushMicrotasks();

      expect(backfiller.isBackfillActive('bsc')).toBe(false);
    });

    it('should allow concurrent backfills for different chains', async () => {
      backfiller.attach(mockSource);

      let resolveFirst: (value: EthLog[]) => void;
      (mockSource as any).sendRequest
        .mockReturnValueOnce(new Promise<EthLog[]>(resolve => { resolveFirst = resolve; }))
        .mockResolvedValueOnce([]);

      // Start backfill for bsc (hangs)
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      // Start backfill for ethereum (proceeds)
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'ethereum' }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledTimes(2);

      resolveFirst!([]);
      await flushMicrotasks();
    });

    it('should release lock after error', async () => {
      const bf = new DataGapBackfiller(mockLogger, { rateLimitMs: 0 });
      bf.attach(mockSource);

      // First call fails
      (mockSource as any).sendRequest.mockRejectedValueOnce(new Error('network error'));

      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      expect(bf.isBackfillActive('bsc')).toBe(false);

      // Second call should proceed (lock released)
      (mockSource as any).sendRequest.mockResolvedValueOnce([]);
      mockSource.emit('dataGap', createDataGapEvent({ chainId: 'bsc' }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledTimes(2);

      bf.detach();
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('getStats()', () => {
    it('should return initial empty stats', () => {
      const stats = backfiller.getStats();
      expect(stats.backfillsAttempted).toBe(0);
      expect(stats.backfillsSucceeded).toBe(0);
      expect(stats.backfillsFailed).toBe(0);
      expect(stats.backfillsRateLimited).toBe(0);
      expect(stats.totalBlocksBackfilled).toBe(0);
      expect(stats.totalLogsRecovered).toBe(0);
    });

    it('should track successful backfills', async () => {
      backfiller.attach(mockSource);
      const mockLogs = [createMockLog(), createMockLog()];
      (mockSource as any).sendRequest.mockResolvedValueOnce(mockLogs);

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 1000, toBlock: 1010, missedBlocks: 11 }));
      await flushMicrotasks();

      const stats = backfiller.getStats();
      expect(stats.backfillsAttempted).toBe(1);
      expect(stats.backfillsSucceeded).toBe(1);
      expect(stats.backfillsFailed).toBe(0);
      expect(stats.totalBlocksBackfilled).toBe(11);
      expect(stats.totalLogsRecovered).toBe(2);
    });

    it('should track failed backfills', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockRejectedValueOnce(new Error('timeout'));

      // Suppress the backfillError event to prevent unhandled
      backfiller.on('backfillError', () => {});

      mockSource.emit('dataGap', createDataGapEvent());
      await flushMicrotasks();

      const stats = backfiller.getStats();
      expect(stats.backfillsAttempted).toBe(1);
      expect(stats.backfillsFailed).toBe(1);
      expect(stats.backfillsSucceeded).toBe(0);
    });

    it('should return a copy (not internal reference)', () => {
      const stats1 = backfiller.getStats();
      (stats1 as any).backfillsAttempted = 999;

      const stats2 = backfiller.getStats();
      expect(stats2.backfillsAttempted).toBe(0);
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should log error when sendRequest fails', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockRejectedValueOnce(new Error('RPC timeout'));
      backfiller.on('backfillError', () => {}); // prevent unhandled

      mockSource.emit('dataGap', createDataGapEvent());
      await flushMicrotasks();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Data gap backfill failed',
        expect.objectContaining({
          chainId: 'bsc',
          error: 'RPC timeout',
        })
      );
    });

    it('should handle non-Error thrown values', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockRejectedValueOnce('string error');
      backfiller.on('backfillError', () => {});

      mockSource.emit('dataGap', createDataGapEvent());
      await flushMicrotasks();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Data gap backfill failed',
        expect.objectContaining({ error: 'string error' })
      );
    });

    it('should not throw when handler errors (catches internally)', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockRejectedValueOnce(new Error('fail'));
      backfiller.on('backfillError', () => {});

      // Should not throw
      mockSource.emit('dataGap', createDataGapEvent());
      await flushMicrotasks();

      // Backfiller should still be functional
      expect(backfiller.getStats().backfillsFailed).toBe(1);
    });
  });

  // ===========================================================================
  // Logging
  // ===========================================================================

  describe('logging', () => {
    it('should log info on backfill start and completion', async () => {
      backfiller.attach(mockSource);
      (mockSource as any).sendRequest.mockResolvedValueOnce([createMockLog()]);

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 1000, toBlock: 1010 }));
      await flushMicrotasks();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting data gap backfill',
        expect.objectContaining({ chainId: 'bsc', fromBlock: 1000 })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Data gap backfill complete',
        expect.objectContaining({ logsRecovered: 1 })
      );
    });
  });

  // ===========================================================================
  // Hex encoding
  // ===========================================================================

  describe('hex encoding', () => {
    it('should encode block numbers as hex in eth_getLogs params', async () => {
      backfiller.attach(mockSource);

      mockSource.emit('dataGap', createDataGapEvent({ fromBlock: 255, toBlock: 256 }));
      await flushMicrotasks();

      expect((mockSource as any).sendRequest).toHaveBeenCalledWith(
        'eth_getLogs',
        [{
          fromBlock: '0xff',
          toBlock: '0x100',
          topics: expect.any(Array),
        }],
        expect.any(Number)
      );
    });
  });
});
