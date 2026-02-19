/**
 * Unit tests for TradeLogger - Persistent trade logging system.
 *
 * Tests cover:
 * - JSONL file creation and append behavior
 * - Daily file rotation via date-based naming
 * - Directory creation on first write
 * - Graceful error handling (never crashes)
 * - Entry building from ExecutionResult + ArbitrageOpportunity
 * - Disabled mode behavior
 * - File path generation
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TradeLogger } from '../../../src/persistence/trade-logger';
import type { TradeLogEntry, TradeLoggerConfig } from '../../../src/persistence/trade-logger';
import { RecordingLogger } from '../../../src/logging/testing-logger';
import type { ExecutionResult } from '@arbitrage/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    opportunityId: 'opp-001',
    success: true,
    transactionHash: '0xabc123',
    actualProfit: 0.05,
    gasUsed: 210000,
    gasCost: 0.003,
    timestamp: 1700000000000,
    chain: 'ethereum',
    dex: 'uniswap_v3',
    latencyMs: 42,
    usedMevProtection: true,
    ...overrides,
  };
}

function createMockOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: 'opp-001',
    type: 'triangular',
    confidence: 0.85,
    timestamp: 1700000000000,
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    amountIn: '1000000000000000000',
    expectedProfit: 0.08,
    buyChain: 'ethereum',
    buyDex: 'uniswap_v3',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('TradeLogger', () => {
  let testDir: string;
  let logger: RecordingLogger;

  beforeEach(async () => {
    logger = new RecordingLogger();
    // Create a unique temp directory for each test
    testDir = path.join(os.tmpdir(), `trade-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ---------------------------------------------------------------------------
  // Directory creation
  // ---------------------------------------------------------------------------

  describe('directory creation', () => {
    it('should create output directory if it does not exist', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);
      const result = createMockResult();

      await tradeLogger.logTrade(result);

      // Verify directory was created
      const stat = await fsp.stat(testDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create nested output directories recursively', async () => {
      const nestedDir = path.join(testDir, 'deep', 'nested', 'dir');
      const tradeLogger = new TradeLogger({ outputDir: nestedDir, enabled: true }, logger);

      await tradeLogger.logTrade(createMockResult());

      const stat = await fsp.stat(nestedDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should only create directory once per instance', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);

      // Write multiple entries
      await tradeLogger.logTrade(createMockResult({ opportunityId: 'opp-1' }));
      await tradeLogger.logTrade(createMockResult({ opportunityId: 'opp-2' }));
      await tradeLogger.logTrade(createMockResult({ opportunityId: 'opp-3' }));

      // All should succeed without errors
      expect(logger.getLogs('warn')).toHaveLength(0);
      expect(logger.getLogs('error')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // JSONL append behavior
  // ---------------------------------------------------------------------------

  describe('JSONL append behavior', () => {
    it('should write a single entry as a valid JSON line', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);
      const result = createMockResult();

      await tradeLogger.logTrade(result);

      const filePath = tradeLogger.getLogPath();
      const content = await fsp.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(1);

      const entry: TradeLogEntry = JSON.parse(lines[0]);
      expect(entry.opportunityId).toBe('opp-001');
      expect(entry.success).toBe(true);
      expect(entry.chain).toBe('ethereum');
      expect(entry.dex).toBe('uniswap_v3');
      expect(entry.transactionHash).toBe('0xabc123');
      expect(entry.actualProfit).toBe(0.05);
      expect(entry.gasUsed).toBe(210000);
      expect(entry.gasCost).toBe(0.003);
      expect(entry.latencyMs).toBe(42);
      expect(entry.usedMevProtection).toBe(true);
    });

    it('should append multiple entries on separate lines', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);

      await tradeLogger.logTrade(createMockResult({ opportunityId: 'opp-1' }));
      await tradeLogger.logTrade(createMockResult({ opportunityId: 'opp-2' }));
      await tradeLogger.logTrade(createMockResult({ opportunityId: 'opp-3' }));

      const filePath = tradeLogger.getLogPath();
      const content = await fsp.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(3);

      const entries = lines.map(line => JSON.parse(line) as TradeLogEntry);
      expect(entries[0].opportunityId).toBe('opp-1');
      expect(entries[1].opportunityId).toBe('opp-2');
      expect(entries[2].opportunityId).toBe('opp-3');
    });

    it('should enrich entry with ArbitrageOpportunity data when provided', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);
      const result = createMockResult();
      const opportunity = createMockOpportunity();

      await tradeLogger.logTrade(result, opportunity);

      const filePath = tradeLogger.getLogPath();
      const content = await fsp.readFile(filePath, 'utf8');
      const entry: TradeLogEntry = JSON.parse(content.trim());

      expect(entry.type).toBe('triangular');
      expect(entry.tokenIn).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      expect(entry.tokenOut).toBe('0x6B175474E89094C44Da98b954EedeAC495271d0F');
      expect(entry.amountIn).toBe('1000000000000000000');
      expect(entry.expectedProfit).toBe(0.08);
    });

    it('should handle entries without optional opportunity data', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);
      const result = createMockResult();

      // Log without opportunity
      await tradeLogger.logTrade(result);

      const filePath = tradeLogger.getLogPath();
      const content = await fsp.readFile(filePath, 'utf8');
      const entry: TradeLogEntry = JSON.parse(content.trim());

      // Optional fields should be undefined (omitted in JSON)
      expect(entry.type).toBeUndefined();
      expect(entry.tokenIn).toBeUndefined();
      expect(entry.tokenOut).toBeUndefined();
      expect(entry.amountIn).toBeUndefined();
      expect(entry.expectedProfit).toBeUndefined();
    });

    it('should log failed execution results with error messages', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);
      const result = createMockResult({
        success: false,
        error: 'Slippage exceeded limit',
        actualProfit: undefined,
        transactionHash: undefined,
      });

      await tradeLogger.logTrade(result);

      const filePath = tradeLogger.getLogPath();
      const content = await fsp.readFile(filePath, 'utf8');
      const entry: TradeLogEntry = JSON.parse(content.trim());

      expect(entry.success).toBe(false);
      expect(entry.error).toBe('Slippage exceeded limit');
      expect(entry.actualProfit).toBeUndefined();
      expect(entry.transactionHash).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Daily file rotation
  // ---------------------------------------------------------------------------

  describe('daily file rotation', () => {
    it('should generate date-based file names', () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);

      const date = new Date('2026-02-19T12:00:00Z');
      const logPath = tradeLogger.getLogPath(date);

      expect(logPath).toBe(path.join(testDir, 'trades-2026-02-19.jsonl'));
    });

    it('should zero-pad month and day in file names', () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);

      // January 5th
      const date = new Date('2026-01-05T00:00:00Z');
      const logPath = tradeLogger.getLogPath(date);

      expect(logPath).toBe(path.join(testDir, 'trades-2026-01-05.jsonl'));
    });

    it('should use current date when no date is provided', () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');

      const logPath = tradeLogger.getLogPath();

      expect(logPath).toBe(path.join(testDir, `trades-${yyyy}-${mm}-${dd}.jsonl`));
    });

    it('should write to different files for different dates', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);

      // We cannot easily simulate date changes in the logTrade method,
      // but we can verify the path generation produces different files
      const date1 = new Date('2026-02-18T00:00:00Z');
      const date2 = new Date('2026-02-19T00:00:00Z');

      const path1 = tradeLogger.getLogPath(date1);
      const path2 = tradeLogger.getLogPath(date2);

      expect(path1).not.toBe(path2);
      expect(path1).toContain('2026-02-18');
      expect(path2).toContain('2026-02-19');
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful error handling
  // ---------------------------------------------------------------------------

  describe('graceful error handling', () => {
    it('should warn on write errors without throwing', async () => {
      // Use an invalid path that will cause a write error
      // On Windows, CON is a reserved device name; on Unix, /dev/null/invalid is invalid
      const invalidDir = path.join(testDir, '\0invalid');
      const tradeLogger = new TradeLogger({ outputDir: invalidDir, enabled: true }, logger);

      // Should not throw
      await tradeLogger.logTrade(createMockResult());

      // Should log a warning
      const warnings = logger.getLogs('warn');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].msg).toContain('Failed to write trade log entry');
    });

    it('should include opportunityId in warning metadata', async () => {
      const invalidDir = path.join(testDir, '\0invalid');
      const tradeLogger = new TradeLogger({ outputDir: invalidDir, enabled: true }, logger);

      await tradeLogger.logTrade(createMockResult({ opportunityId: 'test-opp-42' }));

      const warnings = logger.getLogs('warn');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].meta).toMatchObject({ opportunityId: 'test-opp-42' });
    });
  });

  // ---------------------------------------------------------------------------
  // Disabled mode
  // ---------------------------------------------------------------------------

  describe('disabled mode', () => {
    it('should not write anything when disabled', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: false }, logger);

      await tradeLogger.logTrade(createMockResult());

      // Directory should not even be created
      await expect(fsp.stat(testDir)).rejects.toThrow();
    });

    it('should report enabled status correctly', () => {
      const enabledLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);
      const disabledLogger = new TradeLogger({ outputDir: testDir, enabled: false }, logger);

      expect(enabledLogger.isEnabled()).toBe(true);
      expect(disabledLogger.isEnabled()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // close()
  // ---------------------------------------------------------------------------

  describe('close()', () => {
    it('should reset directory ensured flag on close', async () => {
      const tradeLogger = new TradeLogger({ outputDir: testDir, enabled: true }, logger);

      // Write an entry (ensures directory)
      await tradeLogger.logTrade(createMockResult());

      // Close resets internal state
      await tradeLogger.close();

      // Log debug message should have been emitted
      const debugLogs = logger.getLogs('debug');
      expect(debugLogs.some(l => l.msg.includes('Trade logger closed'))).toBe(true);

      // Writing again should still work (re-ensures directory)
      await tradeLogger.logTrade(createMockResult({ opportunityId: 'after-close' }));

      const filePath = tradeLogger.getLogPath();
      const content = await fsp.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');

      // Should have 2 entries (before close + after close)
      expect(lines).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Default config
  // ---------------------------------------------------------------------------

  describe('default config', () => {
    it('should use default output directory when not specified', () => {
      const tradeLogger = new TradeLogger({}, logger);
      const logPath = tradeLogger.getLogPath();

      expect(logPath).toContain(path.join('data', 'trades'));
    });

    it('should be enabled by default', () => {
      const tradeLogger = new TradeLogger({}, logger);
      expect(tradeLogger.isEnabled()).toBe(true);
    });
  });
});
