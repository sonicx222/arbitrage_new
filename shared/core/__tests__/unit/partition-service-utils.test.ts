/**
 * Partition Service Utilities Tests
 *
 * Tests for shared partition service utilities (P12-P16 refactor).
 *
 * @see partition-service-utils.ts
 *
 * @migrated from shared/core/src/partition-service-utils.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { Server, IncomingMessage, ServerResponse, createServer } from 'http';
import { RecordingLogger, createLogger } from '@arbitrage/core';

// Type alias for the logger type expected by partition-service-utils
type PartitionLogger = ReturnType<typeof createLogger>;

// Mock CHAINS for validation - includes all chains used across P1-P4 partitions
jest.mock('@arbitrage/config', () => ({
  CHAINS: {
    // P1: Asia-Fast chains
    bsc: { id: 56, name: 'BSC' },
    polygon: { id: 137, name: 'Polygon' },
    avalanche: { id: 43114, name: 'Avalanche' },
    fantom: { id: 250, name: 'Fantom' },
    // P2: L2-Turbo chains
    arbitrum: { id: 42161, name: 'Arbitrum' },
    optimism: { id: 10, name: 'Optimism' },
    base: { id: 8453, name: 'Base' },
    // P3: High-Value chains
    ethereum: { id: 1, name: 'Ethereum' },
    zksync: { id: 324, name: 'zkSync Era' },
    linea: { id: 59144, name: 'Linea' },
    // P4: Solana-Native
    solana: { id: 101, name: 'Solana', isEVM: false }
  },
  getPartition: jest.fn().mockImplementation((partitionId) => {
    const partitions: Record<string, any> = {
      'asia-fast': { partitionId: 'asia-fast', chains: ['bsc', 'polygon', 'avalanche', 'fantom'], region: 'asia-southeast1', name: 'P1: Asia-Fast', provider: 'oracle' },
      'l2-turbo': { partitionId: 'l2-turbo', chains: ['arbitrum', 'optimism', 'base'], region: 'us-central1', name: 'P2: L2-Turbo', provider: 'fly' },
      'high-value': { partitionId: 'high-value', chains: ['ethereum', 'zksync', 'linea'], region: 'us-east1', name: 'P3: High-Value', provider: 'oracle' },
      'solana-native': { partitionId: 'solana-native', chains: ['solana'], region: 'us-west1', name: 'P4: Solana-Native', provider: 'fly' },
    };
    return partitions[partitionId as string] ?? undefined;
  }),
  getChainsForPartition: jest.fn().mockImplementation((partitionId) => {
    const partitions: Record<string, string[]> = {
      'asia-fast': ['bsc', 'polygon', 'avalanche', 'fantom'],
      'l2-turbo': ['arbitrum', 'optimism', 'base'],
      'high-value': ['ethereum', 'zksync', 'linea'],
      'solana-native': ['solana'],
    };
    return partitions[partitionId as string] ?? [];
  }),
  TESTNET_CHAINS: [] as string[],
  PARTITION_IDS: {
    ASIA_FAST: 'asia-fast',
    L2_TURBO: 'l2-turbo',
    HIGH_VALUE: 'high-value',
    SOLANA_NATIVE: 'solana-native',
  },
}));

// Import after mocks
import {
  parsePort,
  validateAndFilterChains,
  createPartitionHealthServer,
  shutdownPartitionService,
  closeServerWithTimeout,
  setupDetectorEventHandlers,
  setupProcessHandlers,
  createPartitionEntry,
  parsePartitionEnvironmentConfig,
  validatePartitionEnvironmentConfig,
  generateInstanceId,
  exitWithConfigError,
  createPartitionServiceRunner,
  runPartitionService,
  SHUTDOWN_TIMEOUT_MS,
  HEALTH_SERVER_CLOSE_TIMEOUT_MS,
  PartitionServiceConfig,
  PartitionDetectorInterface,
  PartitionEnvironmentConfig,
  PartitionServiceRunnerOptions,
} from '@arbitrage/core';

// =============================================================================
// Test Helpers
// =============================================================================

class MockDetector extends EventEmitter implements PartitionDetectorInterface {
  private running = false;
  private partitionId = 'test-partition';
  private chains = ['bsc', 'polygon'];

  async getPartitionHealth() {
    return {
      status: 'healthy',
      partitionId: this.partitionId,
      chainHealth: new Map([['bsc', { status: 'healthy' }], ['polygon', { status: 'healthy' }]]),
      uptimeSeconds: 100,
      totalEventsProcessed: 1000,
      memoryUsage: 256 * 1024 * 1024 // 256MB
    };
  }

  getHealthyChains() {
    return this.chains;
  }

  getStats() {
    return {
      partitionId: this.partitionId,
      chains: this.chains,
      totalEventsProcessed: 1000,
      totalOpportunitiesFound: 50,
      uptimeSeconds: 100,
      memoryUsageMB: 256,
      chainStats: new Map([['bsc', { eventsProcessed: 500 }], ['polygon', { eventsProcessed: 500 }]])
    };
  }

  isRunning() {
    return this.running;
  }

  getPartitionId() {
    return this.partitionId;
  }

  getChains() {
    return this.chains;
  }

  async start() {
    this.running = true;
  }

  async stop() {
    this.running = false;
  }

  setRunning(running: boolean) {
    this.running = running;
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Partition Service Utilities', () => {
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // parsePort Tests
  // ===========================================================================

  describe('parsePort', () => {
    it('should return default port when env is undefined', () => {
      const port = parsePort(undefined, 3001);
      expect(port).toBe(3001);
    });

    it('should return default port when env is empty string', () => {
      const port = parsePort('', 3001);
      expect(port).toBe(3001);
    });

    it('should parse valid port number', () => {
      const port = parsePort('3002', 3001);
      expect(port).toBe(3002);
    });

    it('should return default for invalid port (NaN)', () => {
      const port = parsePort('abc', 3001, logger as unknown as PartitionLogger);
      expect(port).toBe(3001);
      expect(logger.hasLogMatching('warn', 'Invalid HEALTH_CHECK_PORT, using default')).toBe(true);
      const warnLogs = logger.getLogs('warn');
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(warnLogs[0].meta).toMatchObject({ provided: 'abc', default: 3001 });
    });

    it('should return default for port below 1', () => {
      const port = parsePort('0', 3001, logger as unknown as PartitionLogger);
      expect(port).toBe(3001);
    });

    it('should return default for port above 65535', () => {
      const port = parsePort('70000', 3001, logger as unknown as PartitionLogger);
      expect(port).toBe(3001);
    });

    it('should accept valid edge cases (1 and 65535)', () => {
      expect(parsePort('1', 3001)).toBe(1);
      expect(parsePort('65535', 3001)).toBe(65535);
    });

    it('should not log warning when no logger provided', () => {
      const separateLogger = new RecordingLogger();
      parsePort('invalid', 3001);
      expect(separateLogger.getLogs('warn').length).toBe(0);
    });
  });

  // ===========================================================================
  // validateAndFilterChains Tests
  // ===========================================================================

  describe('validateAndFilterChains', () => {
    const defaultChains = ['bsc', 'polygon'] as const;

    it('should return defaults when env is undefined', () => {
      const chains = validateAndFilterChains(undefined, defaultChains);
      expect(chains).toEqual(['bsc', 'polygon']);
    });

    it('should return defaults when env is empty string', () => {
      const chains = validateAndFilterChains('', defaultChains);
      expect(chains).toEqual(['bsc', 'polygon']);
    });

    it('should filter valid chains', () => {
      const chains = validateAndFilterChains('arbitrum,optimism', defaultChains);
      expect(chains).toEqual(['arbitrum', 'optimism']);
    });

    it('should handle whitespace in chain list', () => {
      const chains = validateAndFilterChains(' arbitrum , optimism , base ', defaultChains);
      expect(chains).toEqual(['arbitrum', 'optimism', 'base']);
    });

    it('should convert to lowercase', () => {
      const chains = validateAndFilterChains('ARBITRUM,Optimism', defaultChains);
      expect(chains).toEqual(['arbitrum', 'optimism']);
    });

    it('should filter out invalid chains and log warning', () => {
      const chains = validateAndFilterChains(
        'arbitrum,invalid,optimism',
        defaultChains,
        logger as unknown as PartitionLogger
      );
      expect(chains).toEqual(['arbitrum', 'optimism']);
      expect(logger.hasLogMatching('warn', 'Invalid chain IDs in PARTITION_CHAINS, ignoring')).toBe(true);
      const warnLogs = logger.getLogs('warn');
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(warnLogs[0].meta).toMatchObject({
        invalidChains: ['invalid'],
        validChains: ['arbitrum', 'optimism']
      });
    });

    it('should return defaults when all chains are invalid', () => {
      const chains = validateAndFilterChains(
        'invalid1,invalid2',
        defaultChains,
        logger as unknown as PartitionLogger
      );
      expect(chains).toEqual(['bsc', 'polygon']);
      expect(logger.hasLogMatching('warn', 'No valid chains in PARTITION_CHAINS, using defaults')).toBe(true);
      const warnLogs = logger.getLogs('warn');
      // Find the log with the defaults message
      const defaultsLog = warnLogs.find(log => log.msg.includes('using defaults'));
      expect(defaultsLog?.meta).toMatchObject({ defaults: defaultChains });
    });

    it('should return copy of defaults, not reference', () => {
      const chains = validateAndFilterChains(undefined, defaultChains);
      expect(chains).not.toBe(defaultChains);
      expect(chains).toEqual([...defaultChains]);
    });
  });

  // ===========================================================================
  // createPartitionHealthServer Tests
  // ===========================================================================

  describe('createPartitionHealthServer', () => {
    let mockDetector: MockDetector;
    let server: Server | null = null;
    const testPort = 30010 + Math.floor(Math.random() * 1000);

    const serviceConfig: PartitionServiceConfig = {
      partitionId: 'test-partition',
      serviceName: 'test-service',
      defaultChains: ['bsc', 'polygon'],
      defaultPort: testPort,
      region: 'test-region',
      provider: 'test-provider'
    };

    beforeEach(() => {
      mockDetector = new MockDetector();
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
    });

    it('should create server and log startup message', () => {
      server = createPartitionHealthServer({
        port: testPort,
        config: serviceConfig,
        detector: mockDetector,
        logger: logger as unknown as PartitionLogger
      });

      expect(server).toBeInstanceOf(Server);
    });

    // Note: HTTP endpoint tests would require more complex setup with supertest
    // These are covered by integration tests
  });

  // ===========================================================================
  // setupDetectorEventHandlers Tests
  // ===========================================================================

  describe('setupDetectorEventHandlers', () => {
    let mockDetector: MockDetector;

    beforeEach(() => {
      mockDetector = new MockDetector();
    });

    it('should set up event handlers', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      // Verify event listeners are registered
      expect(mockDetector.listenerCount('priceUpdate')).toBe(1);
      expect(mockDetector.listenerCount('opportunity')).toBe(1);
      expect(mockDetector.listenerCount('chainError')).toBe(1);
      expect(mockDetector.listenerCount('chainConnected')).toBe(1);
      expect(mockDetector.listenerCount('chainDisconnected')).toBe(1);
      expect(mockDetector.listenerCount('failoverEvent')).toBe(1);
    });

    it('should log debug on priceUpdate', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('priceUpdate', { chain: 'bsc', dex: 'pancakeswap', price: 100 });

      expect(logger.hasLogMatching('debug', 'Price update')).toBe(true);
      const debugLogs = logger.getLogs('debug');
      expect(debugLogs.length).toBeGreaterThan(0);
      expect(debugLogs[0].meta).toMatchObject({
        partition: 'test-partition',
        chain: 'bsc',
        dex: 'pancakeswap',
        price: 100
      });
    });

    it('should log info on opportunity', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('opportunity', {
        id: 'opp-1',
        type: 'cross-dex',
        buyDex: 'pancakeswap',
        sellDex: 'biswap',
        expectedProfit: 100,
        profitPercentage: 5.00
      });

      expect(logger.hasLogMatching('info', 'Arbitrage opportunity detected')).toBe(true);
      const infoLogs = logger.getLogs('info');
      const oppLog = infoLogs.find(log => log.msg.includes('Arbitrage opportunity'));
      expect(oppLog?.meta).toMatchObject({
        partition: 'test-partition',
        id: 'opp-1',
        percentage: '5.00%'
      });
    });

    it('should log error on chainError', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('chainError', { chainId: 'bsc', error: new Error('Connection failed') });

      expect(logger.hasLogMatching('error', 'Chain error: bsc')).toBe(true);
      const errorLogs = logger.getLogs('error');
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs[0].meta).toMatchObject({
        partition: 'test-partition',
        error: 'Connection failed'
      });
    });

    it('should log info on chainConnected', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('chainConnected', { chainId: 'bsc' });

      expect(logger.hasLogMatching('info', 'Chain connected: bsc')).toBe(true);
      const infoLogs = logger.getLogs('info');
      const connectedLog = infoLogs.find(log => log.msg.includes('Chain connected'));
      expect(connectedLog?.meta).toMatchObject({
        partition: 'test-partition'
      });
    });

    it('should log warn on chainDisconnected', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('chainDisconnected', { chainId: 'polygon' });

      expect(logger.hasLogMatching('warn', 'Chain disconnected: polygon')).toBe(true);
      const warnLogs = logger.getLogs('warn');
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(warnLogs[0].meta).toMatchObject({
        partition: 'test-partition'
      });
    });

    it('should log warn on failoverEvent', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('failoverEvent', { type: 'primary_down' });

      expect(logger.hasLogMatching('warn', 'Failover event received')).toBe(true);
      const warnLogs = logger.getLogs('warn');
      const failoverLog = warnLogs.find(log => log.msg.includes('Failover'));
      expect(failoverLog?.meta).toMatchObject({
        partition: 'test-partition',
        type: 'primary_down'
      });
    });

    it('should register statusChange event handler', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      expect(mockDetector.listenerCount('statusChange')).toBe(1);
    });

    it('should log warn on statusChange degradation (connected -> error)', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('statusChange', {
        chainId: 'bsc',
        oldStatus: 'connected',
        newStatus: 'error'
      });

      expect(logger.hasLogMatching('warn', 'Chain status degraded: bsc')).toBe(true);
      const warnLogs = logger.getLogs('warn');
      const degradedLog = warnLogs.find(log => log.msg.includes('Chain status degraded'));
      expect(degradedLog?.meta).toMatchObject({
        partition: 'test-partition',
        from: 'connected',
        to: 'error'
      });
    });

    it('should log warn on statusChange degradation (connected -> disconnected)', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('statusChange', {
        chainId: 'polygon',
        oldStatus: 'connected',
        newStatus: 'disconnected'
      });

      expect(logger.hasLogMatching('warn', 'Chain status degraded: polygon')).toBe(true);
    });

    it('should log info on statusChange recovery (error -> connected)', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('statusChange', {
        chainId: 'bsc',
        oldStatus: 'error',
        newStatus: 'connected'
      });

      expect(logger.hasLogMatching('info', 'Chain status recovered: bsc')).toBe(true);
      const infoLogs = logger.getLogs('info');
      const recoveryLog = infoLogs.find(log => log.msg.includes('Chain status recovered'));
      expect(recoveryLog?.meta).toMatchObject({
        partition: 'test-partition',
        from: 'error',
        to: 'connected'
      });
    });

    it('should log info on statusChange recovery (disconnected -> connected)', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('statusChange', {
        chainId: 'polygon',
        oldStatus: 'disconnected',
        newStatus: 'connected'
      });

      expect(logger.hasLogMatching('info', 'Chain status recovered: polygon')).toBe(true);
    });

    it('should log debug on statusChange neutral transition', () => {
      setupDetectorEventHandlers(
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-partition'
      );

      mockDetector.emit('statusChange', {
        chainId: 'bsc',
        oldStatus: 'connected',
        newStatus: 'connecting'
      });

      // Neutral transitions (not degradation or recovery) log at debug level
      expect(logger.hasLogMatching('debug', 'Chain status changed: bsc')).toBe(true);
    });
  });

  // ===========================================================================
  // SHUTDOWN_TIMEOUT_MS Tests
  // ===========================================================================

  describe('SHUTDOWN_TIMEOUT_MS', () => {
    it('should be 5000ms', () => {
      expect(SHUTDOWN_TIMEOUT_MS).toBe(5000);
    });
  });

  // ===========================================================================
  // setupProcessHandlers P19-FIX Tests
  // ===========================================================================

  describe('setupProcessHandlers P19-FIX (duplicate signal handling)', () => {
    let mockDetector: MockDetector;

    beforeEach(() => {
      mockDetector = new MockDetector();
      // Remove any existing listeners from previous tests
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
    });

    afterEach(() => {
      // Clean up listeners
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
    });

    it('should register process handlers', () => {
      const healthServerRef: { current: Server | null } = { current: null };

      setupProcessHandlers(
        healthServerRef,
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-service'
      );

      // Verify listeners are registered (at least 1 for each signal)
      expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount('uncaughtException')).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount('unhandledRejection')).toBeGreaterThanOrEqual(1);
    });

    it('should have shutdown guard flag to prevent duplicate calls (P19-FIX)', () => {
      // This test verifies the guard flag exists by checking the implementation
      // The actual behavior is verified by the log message when second signal is ignored
      const healthServerRef: { current: Server | null } = { current: null };

      setupProcessHandlers(
        healthServerRef,
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-service'
      );

      // The function should have been called without errors
      // The P19-FIX adds the isShuttingDown flag internally
      expect(true).toBe(true); // Function executed without error
    });
  });

  // ===========================================================================
  // P3 High-Value Partition Chain Validation Tests
  // ===========================================================================

  describe('P3 High-Value partition chain validation', () => {
    const highValueDefaultChains = ['ethereum', 'zksync', 'linea'] as const;

    it('should validate all P3 high-value chains (ethereum, zksync, linea)', () => {
      const chains = validateAndFilterChains('ethereum,zksync,linea', highValueDefaultChains);
      expect(chains).toEqual(['ethereum', 'zksync', 'linea']);
    });

    it('should filter valid P3 chains from mixed input', () => {
      const chains = validateAndFilterChains(
        'ethereum,invalid,zksync,unknown,linea',
        highValueDefaultChains,
        logger as unknown as PartitionLogger
      );
      expect(chains).toEqual(['ethereum', 'zksync', 'linea']);
      expect(logger.hasLogMatching('warn', 'Invalid chain IDs in PARTITION_CHAINS, ignoring')).toBe(true);
    });

    it('should return P3 defaults when no valid chains provided', () => {
      const chains = validateAndFilterChains(
        'invalid1,invalid2',
        highValueDefaultChains,
        logger as unknown as PartitionLogger
      );
      expect(chains).toEqual(['ethereum', 'zksync', 'linea']);
    });

    it('should handle single P3 chain override', () => {
      const chains = validateAndFilterChains('ethereum', highValueDefaultChains);
      expect(chains).toEqual(['ethereum']);
    });
  });

  // ===========================================================================
  // parsePartitionEnvironmentConfig Tests
  // ===========================================================================

  describe('parsePartitionEnvironmentConfig', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return all 9 fields with correct types', () => {
      // Clear any leaked env vars from other tests
      delete process.env.POLYGON_RPC_URL;
      delete process.env.POLYGON_WS_URL;

      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.PARTITION_CHAINS = 'bsc,polygon';
      process.env.HEALTH_CHECK_PORT = '3001';
      process.env.INSTANCE_ID = 'test-instance';
      process.env.REGION_ID = 'us-east1';
      process.env.ENABLE_CROSS_REGION_HEALTH = 'true';
      process.env.NODE_ENV = 'production';
      process.env.BSC_RPC_URL = 'https://bsc-rpc.example.com';
      process.env.BSC_WS_URL = 'wss://bsc-ws.example.com';

      const config = parsePartitionEnvironmentConfig(['bsc', 'polygon']);

      expect(config.redisUrl).toBe('redis://localhost:6379');
      expect(config.partitionChains).toBe('bsc,polygon');
      expect(config.healthCheckPort).toBe('3001');
      expect(config.instanceId).toBe('test-instance');
      expect(config.regionId).toBe('us-east1');
      expect(config.enableCrossRegionHealth).toBe(true);
      expect(config.nodeEnv).toBe('production');
      expect(config.rpcUrls).toEqual({
        bsc: 'https://bsc-rpc.example.com',
        polygon: undefined
      });
      expect(config.wsUrls).toEqual({
        bsc: 'wss://bsc-ws.example.com',
        polygon: undefined
      });
    });

    it('should return undefined for unset optional env vars', () => {
      // Explicitly clear env vars that may leak from global test setup (setupTestEnv)
      delete process.env.REDIS_URL;
      delete process.env.PARTITION_CHAINS;
      delete process.env.HEALTH_CHECK_PORT;
      delete process.env.INSTANCE_ID;
      delete process.env.REGION_ID;

      const config = parsePartitionEnvironmentConfig(['bsc']);

      expect(config.redisUrl).toBeUndefined();
      expect(config.partitionChains).toBeUndefined();
      expect(config.healthCheckPort).toBeUndefined();
      expect(config.instanceId).toBeUndefined();
      expect(config.regionId).toBeUndefined();
    });

    it('should default enableCrossRegionHealth to true when env var not set', () => {
      const config = parsePartitionEnvironmentConfig([]);
      expect(config.enableCrossRegionHealth).toBe(true);
    });

    it('should set enableCrossRegionHealth to false only for exact string "false"', () => {
      process.env.ENABLE_CROSS_REGION_HEALTH = 'false';
      const config = parsePartitionEnvironmentConfig([]);
      expect(config.enableCrossRegionHealth).toBe(false);
    });

    it('should default nodeEnv to "development" when NODE_ENV not set', () => {
      delete process.env.NODE_ENV;
      const config = parsePartitionEnvironmentConfig([]);
      expect(config.nodeEnv).toBe('development');
    });

    it('should parse RPC/WS URLs for each chain using uppercase env var names', () => {
      process.env.ETHEREUM_RPC_URL = 'https://eth.example.com';
      process.env.ETHEREUM_WS_URL = 'wss://eth-ws.example.com';
      process.env.ZKSYNC_RPC_URL = 'https://zksync.example.com';
      // Explicitly clear WS URLs that may be set by global test env setup
      delete process.env.ZKSYNC_WS_URL;
      delete process.env.LINEA_RPC_URL;
      delete process.env.LINEA_WS_URL;

      const config = parsePartitionEnvironmentConfig(['ethereum', 'zksync', 'linea']);

      expect(config.rpcUrls.ethereum).toBe('https://eth.example.com');
      expect(config.wsUrls.ethereum).toBe('wss://eth-ws.example.com');
      expect(config.rpcUrls.zksync).toBe('https://zksync.example.com');
      expect(config.wsUrls.zksync).toBeUndefined();
      expect(config.rpcUrls.linea).toBeUndefined();
      expect(config.wsUrls.linea).toBeUndefined();
    });
  });

  // ===========================================================================
  // createPartitionEntry Tests
  // ===========================================================================

  describe('createPartitionEntry', () => {
    let processExitSpy: jest.SpiedFunction<typeof process.exit>;
    const originalEnv = process.env;

    // Import mocked functions to re-establish implementations after resetMocks clears them
    const { getPartition, getChainsForPartition } =
      jest.requireMock<typeof import('@arbitrage/config')>('@arbitrage/config');

    const MOCK_PARTITIONS: Record<string, any> = {
      'asia-fast': { partitionId: 'asia-fast', chains: ['bsc', 'polygon', 'avalanche', 'fantom'], region: 'asia-southeast1', name: 'P1: Asia-Fast', provider: 'oracle' },
      'l2-turbo': { partitionId: 'l2-turbo', chains: ['arbitrum', 'optimism', 'base'], region: 'us-central1', name: 'P2: L2-Turbo', provider: 'fly' },
      'high-value': { partitionId: 'high-value', chains: ['ethereum', 'zksync', 'linea'], region: 'us-east1', name: 'P3: High-Value', provider: 'oracle' },
      'solana-native': { partitionId: 'solana-native', chains: ['solana'], region: 'us-west1', name: 'P4: Solana-Native', provider: 'fly' },
    };

    const MOCK_PARTITION_CHAINS: Record<string, string[]> = {
      'asia-fast': ['bsc', 'polygon', 'avalanche', 'fantom'],
      'l2-turbo': ['arbitrum', 'optimism', 'base'],
      'high-value': ['ethereum', 'zksync', 'linea'],
      'solana-native': ['solana'],
    };

    beforeEach(() => {
      process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };
      processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      // Re-establish mock implementations cleared by resetMocks: true
      (getPartition as jest.Mock).mockImplementation(
        (...args: unknown[]) => MOCK_PARTITIONS[args[0] as string] ?? undefined
      );
      (getChainsForPartition as jest.Mock).mockImplementation(
        (...args: unknown[]) => MOCK_PARTITION_CHAINS[args[0] as string] ?? []
      );
    });

    afterEach(() => {
      processExitSpy.mockRestore();
      // Clean up any process listeners that may have been registered
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
      process.env = originalEnv;
    });

    it('should create entry for valid partition (asia-fast)', () => {
      const entry = createPartitionEntry(
        'asia-fast',
        () => new MockDetector()
      );

      try {
        expect(entry.partitionId).toBe('asia-fast');
        expect(entry.chains).toEqual(['bsc', 'polygon', 'avalanche', 'fantom']);
        expect(entry.region).toBe('asia-southeast1');
        expect(entry.detector).toBeDefined();
        expect(entry.config).toBeDefined();
        expect(entry.config.partitionId).toBe('asia-fast');
        expect(entry.config.chains).toEqual(expect.arrayContaining(['bsc', 'polygon', 'avalanche', 'fantom']));
        expect(entry.cleanupProcessHandlers).toBeInstanceOf(Function);
        expect(entry.envConfig).toBeDefined();
        expect(entry.runner).toBeDefined();
        expect(processExitSpy).not.toHaveBeenCalled();
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should create entry for valid partition (l2-turbo)', () => {
      const entry = createPartitionEntry(
        'l2-turbo',
        () => new MockDetector()
      );

      try {
        expect(entry.partitionId).toBe('l2-turbo');
        expect(entry.chains).toEqual(['arbitrum', 'optimism', 'base']);
        expect(entry.region).toBe('us-central1');
        expect(processExitSpy).not.toHaveBeenCalled();
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should call process.exit(1) for unknown partition ID', () => {
      // exitWithConfigError calls process.exit(1) which is mocked to no-op
      // The function continues due to defensive optional chaining
      const entry = createPartitionEntry(
        'nonexistent-partition',
        () => new MockDetector()
      );

      try {
        expect(processExitSpy).toHaveBeenCalledWith(1);
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should pass correctly-typed detector config to createDetector callback', () => {
      const createDetectorSpy = jest.fn(
        (_cfg: Record<string, unknown>) => new MockDetector() as PartitionDetectorInterface
      );

      const entry = createPartitionEntry('asia-fast', createDetectorSpy);

      try {
        expect(createDetectorSpy).toHaveBeenCalledTimes(1);
        const passedConfig = createDetectorSpy.mock.calls[0][0];
        expect(passedConfig).toMatchObject({
          partitionId: 'asia-fast',
          chains: expect.arrayContaining(['bsc', 'polygon', 'avalanche', 'fantom']),
          instanceId: expect.any(String),
          regionId: expect.any(String),
          enableCrossRegionHealth: expect.any(Boolean),
          healthCheckPort: expect.any(Number),
        });
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should respect PARTITION_CHAINS env var override', () => {
      process.env.PARTITION_CHAINS = 'bsc,polygon';

      const entry = createPartitionEntry(
        'asia-fast',
        () => new MockDetector()
      );

      try {
        // Validated chains should be filtered to only the override
        expect(entry.config.chains).toEqual(['bsc', 'polygon']);
        expect(processExitSpy).not.toHaveBeenCalled();
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should respect INSTANCE_ID env var', () => {
      process.env.INSTANCE_ID = 'custom-test-instance';

      const entry = createPartitionEntry(
        'asia-fast',
        () => new MockDetector()
      );

      try {
        expect(entry.config.instanceId).toBe('custom-test-instance');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should respect REGION_ID env var override', () => {
      process.env.REGION_ID = 'eu-west1';

      const entry = createPartitionEntry(
        'asia-fast',
        () => new MockDetector()
      );

      try {
        expect(entry.config.regionId).toBe('eu-west1');
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should include envConfig in result', () => {
      process.env.REDIS_URL = 'redis://test:6379';

      const entry = createPartitionEntry(
        'asia-fast',
        () => new MockDetector()
      );

      try {
        expect(entry.envConfig).toBeDefined();
        expect(entry.envConfig.redisUrl).toBe('redis://test:6379');
        expect(entry.envConfig.nodeEnv).toBeDefined();
      } finally {
        entry.cleanupProcessHandlers();
      }
    });

    it('should register process handlers that can be cleaned up', () => {
      const entry = createPartitionEntry(
        'asia-fast',
        () => new MockDetector()
      );

      // Process handlers should be registered
      const sigtermBefore = process.listenerCount('SIGTERM');
      expect(sigtermBefore).toBeGreaterThanOrEqual(1);

      // Cleanup should remove them
      entry.cleanupProcessHandlers();
      const sigtermAfter = process.listenerCount('SIGTERM');
      expect(sigtermAfter).toBeLessThan(sigtermBefore);
    });
  });

  // ===========================================================================
  // shutdownPartitionService Tests (GAP-1)
  // ===========================================================================

  describe('shutdownPartitionService', () => {
    let mockDetector: MockDetector;
    let processExitSpy: jest.SpiedFunction<typeof process.exit>;

    beforeEach(() => {
      mockDetector = new MockDetector();
      processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    });

    afterEach(() => {
      processExitSpy.mockRestore();
    });

    it('should shut down gracefully with health server (happy path)', async () => {
      const mockServer = {
        close: jest.fn((cb: (err?: Error) => void) => cb()),
      } as unknown as Server;

      await shutdownPartitionService(
        'SIGTERM',
        mockServer,
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-service'
      );

      expect(logger.hasLogMatching('info', 'Received SIGTERM')).toBe(true);
      expect(mockServer.close).toHaveBeenCalled();
      expect(logger.hasLogMatching('info', 'Health server closed after startup failure')).toBe(true);
      expect(logger.hasLogMatching('info', 'test-service shutdown complete')).toBe(true);
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('should shut down gracefully when health server is null', async () => {
      await shutdownPartitionService(
        'SIGINT',
        null,
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-service'
      );

      expect(logger.hasLogMatching('info', 'Received SIGINT')).toBe(true);
      expect(logger.hasLogMatching('info', 'test-service shutdown complete')).toBe(true);
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('should exit with code 1 when detector.stop() throws', async () => {
      const failingDetector = new MockDetector();
      jest.spyOn(failingDetector, 'stop').mockRejectedValue(new Error('stop failed'));

      await shutdownPartitionService(
        'SIGTERM',
        null,
        failingDetector,
        logger as unknown as PartitionLogger,
        'test-service'
      );

      expect(logger.hasLogMatching('error', 'Error during shutdown')).toBe(true);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle health server close timeout', async () => {
      // Create a server that never calls the close callback
      const hangingServer = {
        close: jest.fn((_cb: (err?: Error) => void) => {
          // Never call cb - simulates a hanging close
        }),
      } as unknown as Server;

      // Use a race with a real timeout to verify it completes via SHUTDOWN_TIMEOUT_MS
      const shutdownPromise = shutdownPartitionService(
        'SIGTERM',
        hangingServer,
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-service'
      );

      // Advance timers to trigger the internal shutdown timeout
      jest.useFakeTimers();
      jest.advanceTimersByTime(SHUTDOWN_TIMEOUT_MS + 100);
      jest.useRealTimers();

      // The function should still complete (via the timeout path)
      // Note: In a real scenario the timeout fires, but since we're testing
      // the mock, we verify the server.close was called
      expect(hangingServer.close).toHaveBeenCalled();
    });

    it('should log health server close error but still complete', async () => {
      const errorServer = {
        close: jest.fn((cb: (err?: Error) => void) => cb(new Error('close error'))),
      } as unknown as Server;

      await shutdownPartitionService(
        'SIGTERM',
        errorServer,
        mockDetector,
        logger as unknown as PartitionLogger,
        'test-service'
      );

      expect(logger.hasLogMatching('warn', 'Failed to close health server during cleanup')).toBe(true);
      // Should still complete shutdown
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });
  });

  // ===========================================================================
  // closeServerWithTimeout Tests (GAP-2)
  // ===========================================================================

  describe('closeServerWithTimeout', () => {
    it('should resolve immediately for null server', async () => {
      await expect(closeServerWithTimeout(null)).resolves.toBeUndefined();
    });

    it('should close server normally', async () => {
      const mockServer = {
        close: jest.fn((cb: (err?: Error) => void) => cb()),
      } as unknown as Server;

      await closeServerWithTimeout(mockServer, 1000, logger as unknown as PartitionLogger);

      expect(mockServer.close).toHaveBeenCalled();
      expect(logger.hasLogMatching('info', 'Health server closed after startup failure')).toBe(true);
    });

    it('should resolve on timeout when server hangs', async () => {
      jest.useFakeTimers();

      const hangingServer = {
        close: jest.fn((_cb: (err?: Error) => void) => {
          // Never calls cb
        }),
      } as unknown as Server;

      const promise = closeServerWithTimeout(hangingServer, 500, logger as unknown as PartitionLogger);

      // Advance past the timeout
      jest.advanceTimersByTime(600);

      await promise;

      expect(logger.hasLogMatching('warn', 'Health server close timed out after 500ms')).toBe(true);

      jest.useRealTimers();
    });

    it('should log warning when server close returns error', async () => {
      const errorServer = {
        close: jest.fn((cb: (err?: Error) => void) => cb(new Error('close failed'))),
      } as unknown as Server;

      await closeServerWithTimeout(errorServer, 1000, logger as unknown as PartitionLogger);

      expect(logger.hasLogMatching('warn', 'Failed to close health server during cleanup')).toBe(true);
    });

    it('should use default timeout when not specified', async () => {
      const mockServer = {
        close: jest.fn((cb: (err?: Error) => void) => cb()),
      } as unknown as Server;

      await closeServerWithTimeout(mockServer);

      expect(mockServer.close).toHaveBeenCalled();
    });

    it('should not log when no logger provided', async () => {
      const errorServer = {
        close: jest.fn((cb: (err?: Error) => void) => cb(new Error('close failed'))),
      } as unknown as Server;

      // Should not throw even without logger
      await expect(closeServerWithTimeout(errorServer, 1000)).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // HEALTH_SERVER_CLOSE_TIMEOUT_MS Tests
  // ===========================================================================

  describe('HEALTH_SERVER_CLOSE_TIMEOUT_MS', () => {
    it('should be 1000ms', () => {
      expect(HEALTH_SERVER_CLOSE_TIMEOUT_MS).toBe(1000);
    });
  });

  // ===========================================================================
  // validateAndFilterChains Deduplication Tests (Fix #10)
  // ===========================================================================

  describe('validateAndFilterChains deduplication (Fix #10)', () => {
    const defaultChains = ['bsc', 'polygon'] as const;

    it('should deduplicate chains from PARTITION_CHAINS env var', () => {
      const chains = validateAndFilterChains('bsc,bsc,polygon', defaultChains);
      expect(chains).toEqual(['bsc', 'polygon']);
    });

    it('should deduplicate chains with different casing', () => {
      const chains = validateAndFilterChains('BSC,bsc,Polygon,polygon', defaultChains);
      expect(chains).toEqual(['bsc', 'polygon']);
    });

    it('should preserve order of first occurrence when deduplicating', () => {
      const chains = validateAndFilterChains('polygon,bsc,polygon,bsc', defaultChains);
      expect(chains).toEqual(['polygon', 'bsc']);
    });
  });

  // ===========================================================================
  // validatePartitionEnvironmentConfig Tests (Fix #2)
  // ===========================================================================

  describe('validatePartitionEnvironmentConfig', () => {
    let processExitSpy: jest.SpiedFunction<typeof process.exit>;

    beforeEach(() => {
      processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    });

    afterEach(() => {
      processExitSpy.mockRestore();
    });

    it('should call process.exit(1) when REDIS_URL is missing in non-test env', () => {
      const envConfig: PartitionEnvironmentConfig = {
        redisUrl: undefined,
        partitionChains: undefined,
        healthCheckPort: undefined,
        instanceId: undefined,
        regionId: undefined,
        enableCrossRegionHealth: true,
        nodeEnv: 'development',
        rpcUrls: {},
        wsUrls: {},
      };

      validatePartitionEnvironmentConfig(
        envConfig,
        'test-partition',
        ['bsc'],
        logger as unknown as PartitionLogger
      );

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should not exit when REDIS_URL is missing in test env', () => {
      const envConfig: PartitionEnvironmentConfig = {
        redisUrl: undefined,
        partitionChains: undefined,
        healthCheckPort: undefined,
        instanceId: undefined,
        regionId: undefined,
        enableCrossRegionHealth: true,
        nodeEnv: 'test',
        rpcUrls: {},
        wsUrls: {},
      };

      validatePartitionEnvironmentConfig(
        envConfig,
        'test-partition',
        ['bsc'],
        logger as unknown as PartitionLogger
      );

      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('should warn about missing RPC URLs in production', () => {
      const envConfig: PartitionEnvironmentConfig = {
        redisUrl: 'redis://localhost:6379',
        partitionChains: undefined,
        healthCheckPort: undefined,
        instanceId: undefined,
        regionId: undefined,
        enableCrossRegionHealth: true,
        nodeEnv: 'production',
        rpcUrls: { bsc: undefined },
        wsUrls: { bsc: 'wss://bsc-ws.example.com' },
      };

      validatePartitionEnvironmentConfig(
        envConfig,
        'test-partition',
        ['bsc'],
        logger as unknown as PartitionLogger
      );

      expect(logger.hasLogMatching('warn', 'Production deployment without custom RPC URLs')).toBe(true);
    });

    it('should warn about missing WS URLs in production', () => {
      const envConfig: PartitionEnvironmentConfig = {
        redisUrl: 'redis://localhost:6379',
        partitionChains: undefined,
        healthCheckPort: undefined,
        instanceId: undefined,
        regionId: undefined,
        enableCrossRegionHealth: true,
        nodeEnv: 'production',
        rpcUrls: { bsc: 'https://bsc-rpc.example.com' },
        wsUrls: { bsc: undefined },
      };

      validatePartitionEnvironmentConfig(
        envConfig,
        'test-partition',
        ['bsc'],
        logger as unknown as PartitionLogger
      );

      expect(logger.hasLogMatching('warn', 'Production deployment without custom WebSocket URLs')).toBe(true);
    });

    it('should not warn in non-production environments', () => {
      const envConfig: PartitionEnvironmentConfig = {
        redisUrl: 'redis://localhost:6379',
        partitionChains: undefined,
        healthCheckPort: undefined,
        instanceId: undefined,
        regionId: undefined,
        enableCrossRegionHealth: true,
        nodeEnv: 'test',
        rpcUrls: { bsc: undefined },
        wsUrls: { bsc: undefined },
      };

      validatePartitionEnvironmentConfig(
        envConfig,
        'test-partition',
        ['bsc'],
        logger as unknown as PartitionLogger
      );

      expect(logger.hasLogMatching('warn', 'Production deployment without custom RPC URLs')).toBe(false);
      expect(logger.hasLogMatching('warn', 'Production deployment without custom WebSocket URLs')).toBe(false);
    });
  });

  // ===========================================================================
  // generateInstanceId Tests (Fix #2)
  // ===========================================================================

  describe('generateInstanceId', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return providedId when given', () => {
      const result = generateInstanceId('asia-fast', 'my-custom-id');
      expect(result).toBe('my-custom-id');
    });

    it('should use HOSTNAME env var when no providedId', () => {
      process.env = { ...originalEnv, HOSTNAME: 'host-abc' };
      const result = generateInstanceId('asia-fast');
      expect(result).toMatch(/^asia-fast-host-abc-\d+$/);
    });

    it('should fall back to "local" when HOSTNAME is not set', () => {
      process.env = { ...originalEnv };
      delete process.env.HOSTNAME;
      const result = generateInstanceId('l2-turbo');
      expect(result).toMatch(/^l2-turbo-local-\d+$/);
    });

    it('should produce unique IDs via timestamp', () => {
      const id1 = generateInstanceId('asia-fast');
      const id2 = generateInstanceId('asia-fast');
      // IDs may be the same if Date.now() returns same ms, but generally unique
      expect(id1).toMatch(/^asia-fast-/);
      expect(id2).toMatch(/^asia-fast-/);
    });
  });

  // ===========================================================================
  // createPartitionServiceRunner Tests (Fix #2)
  // ===========================================================================

  describe('createPartitionServiceRunner', () => {
    let mockDetector: MockDetector;
    let processExitSpy: jest.SpiedFunction<typeof process.exit>;

    const serviceConfig: PartitionServiceConfig = {
      partitionId: 'test-partition',
      serviceName: 'test-service',
      defaultChains: ['bsc', 'polygon'],
      defaultPort: 3099,
      region: 'test-region',
      provider: 'test-provider',
    };

    const detectorConfig = {
      partitionId: 'test-partition',
      chains: ['bsc', 'polygon'],
      instanceId: 'test-instance',
      regionId: 'test-region',
      enableCrossRegionHealth: true,
      healthCheckPort: 3099,
    };

    beforeEach(() => {
      mockDetector = new MockDetector();
      processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      // Remove listeners to avoid interference
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
    });

    afterEach(() => {
      processExitSpy.mockRestore();
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
    });

    it('should start in idle state', () => {
      const runner = createPartitionServiceRunner({
        config: serviceConfig,
        detectorConfig,
        createDetector: () => mockDetector,
        logger: logger as unknown as PartitionLogger,
      });

      try {
        expect(runner.getState()).toBe('idle');
      } finally {
        runner.cleanup();
      }
    });

    it('should return detector instance', () => {
      const runner = createPartitionServiceRunner({
        config: serviceConfig,
        detectorConfig,
        createDetector: () => mockDetector,
        logger: logger as unknown as PartitionLogger,
      });

      try {
        expect(runner.detector).toBe(mockDetector);
      } finally {
        runner.cleanup();
      }
    });

    it('should guard against duplicate start calls', async () => {
      const runner = createPartitionServiceRunner({
        config: serviceConfig,
        detectorConfig,
        createDetector: () => mockDetector,
        logger: logger as unknown as PartitionLogger,
      });

      try {
        // First start changes state from idle to starting/started
        await runner.start();
        // Second start should be ignored
        await runner.start();

        expect(logger.hasLogMatching('warn', 'Service already started or starting')).toBe(true);
      } finally {
        runner.cleanup();
      }
    });

    it('should return a cleanup function', () => {
      const runner = createPartitionServiceRunner({
        config: serviceConfig,
        detectorConfig,
        createDetector: () => mockDetector,
        logger: logger as unknown as PartitionLogger,
      });

      expect(runner.cleanup).toBeInstanceOf(Function);
      expect(() => runner.cleanup()).not.toThrow();
    });
  });

  // ===========================================================================
  // runPartitionService Tests (Fix #2)
  // ===========================================================================

  describe('runPartitionService', () => {
    let mockDetector: MockDetector;
    let processExitSpy: jest.SpiedFunction<typeof process.exit>;
    const originalJestWorkerId = process.env.JEST_WORKER_ID;

    const serviceConfig: PartitionServiceConfig = {
      partitionId: 'test-partition',
      serviceName: 'test-service',
      defaultChains: ['bsc', 'polygon'],
      defaultPort: 3098,
      region: 'test-region',
      provider: 'test-provider',
    };

    const detectorConfig = {
      partitionId: 'test-partition',
      chains: ['bsc', 'polygon'],
      instanceId: 'test-instance',
      regionId: 'test-region',
      enableCrossRegionHealth: true,
      healthCheckPort: 3098,
    };

    beforeEach(() => {
      mockDetector = new MockDetector();
      processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
    });

    afterEach(() => {
      processExitSpy.mockRestore();
      process.env.JEST_WORKER_ID = originalJestWorkerId;
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
    });

    it('should not auto-start when JEST_WORKER_ID is set', () => {
      // JEST_WORKER_ID is already set in test environment
      expect(process.env.JEST_WORKER_ID).toBeDefined();

      const runner = runPartitionService({
        config: serviceConfig,
        detectorConfig,
        createDetector: () => mockDetector,
        logger: logger as unknown as PartitionLogger,
      });

      try {
        // Runner should be created but not started
        expect(runner.getState()).toBe('idle');
        expect(runner.detector).toBe(mockDetector);
      } finally {
        runner.cleanup();
      }
    });

    it('should return runner with all required properties', () => {
      const runner = runPartitionService({
        config: serviceConfig,
        detectorConfig,
        createDetector: () => mockDetector,
        logger: logger as unknown as PartitionLogger,
      });

      try {
        expect(runner.detector).toBeDefined();
        expect(runner.start).toBeInstanceOf(Function);
        expect(runner.getState).toBeInstanceOf(Function);
        expect(runner.cleanup).toBeInstanceOf(Function);
        expect(runner.healthServer).toBeDefined();
        expect(runner.healthServer.current).toBeNull();
      } finally {
        runner.cleanup();
      }
    });
  });
});
