/**
 * Partition Service Mocks
 *
 * Consolidated mocks for partition service unit and integration tests.
 * Reduces code duplication across P1-P4 partition test suites.
 *
 * Usage:
 * ```typescript
 * import {
 *   createMockLogger,
 *   createMockStateManager,
 *   MockUnifiedChainDetector,
 *   createCoreMocks,
 *   createConfigMocks,
 *   createUnifiedDetectorMocks
 * } from '@arbitrage/test-utils';
 * ```
 *
 * @see services/partition-asia-fast/src/__tests__/unit/index.test.ts
 */

import { EventEmitter } from 'events';

// =============================================================================
// Logger Mock
// =============================================================================

export interface MockLogger {
  info: jest.Mock;
  error: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
}

/**
 * Creates a mock logger with jest.fn() implementations for all log methods.
 */
export function createMockLogger(): MockLogger {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

// =============================================================================
// State Manager Mock
// =============================================================================

export interface MockStateManager {
  executeStart: jest.Mock;
  executeStop: jest.Mock;
  isRunning: jest.Mock;
  getState: jest.Mock;
}

/**
 * Creates a mock ServiceStateManager with execute functions that invoke callbacks.
 */
export function createMockStateManager(): MockStateManager {
  return {
    executeStart: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
      try {
        await fn();
        return { success: true };
      } catch (error) {
        return { success: false, error };
      }
    }),
    executeStop: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
      try {
        await fn();
        return { success: true };
      } catch (error) {
        return { success: false, error };
      }
    }),
    isRunning: jest.fn().mockReturnValue(false),
    getState: jest.fn().mockReturnValue('idle'),
  };
}

// =============================================================================
// Unified Chain Detector Mock
// =============================================================================

export interface MockDetectorOptions {
  partitionId?: string;
  chains?: string[];
  isRunning?: boolean;
}

/**
 * Mock implementation of UnifiedChainDetector for testing.
 * Extends EventEmitter to support event-based testing.
 */
export class MockUnifiedChainDetector extends EventEmitter {
  private partitionId: string;
  private chains: string[];
  private running: boolean;

  constructor(options: MockDetectorOptions = {}) {
    super();
    this.partitionId = options.partitionId || 'test-partition';
    this.chains = options.chains || ['bsc', 'polygon'];
    this.running = options.isRunning || false;
  }

  async start(): Promise<void> {
    this.running = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getPartitionId(): string {
    return this.partitionId;
  }

  getChains(): string[] {
    return [...this.chains];
  }

  getHealthyChains(): string[] {
    return this.running ? [...this.chains] : [];
  }

  async getPartitionHealth() {
    return {
      status: this.running ? 'healthy' : 'unhealthy',
      partitionId: this.partitionId,
      chainHealth: new Map(this.chains.map(c => [c, { status: 'healthy' }])),
      uptimeSeconds: 100,
      totalEventsProcessed: 1000,
      memoryUsage: 100 * 1024 * 1024, // 100MB
    };
  }

  getStats() {
    return {
      partitionId: this.partitionId,
      chains: this.chains,
      totalEventsProcessed: 1000,
      totalOpportunitiesFound: 10,
      uptimeSeconds: 100,
      memoryUsageMB: 100,
      chainStats: new Map(),
    };
  }
}

// =============================================================================
// Core Module Mocks Factory
// =============================================================================

/**
 * Creates the mock implementation object for @arbitrage/core module.
 * Use with jest.mock('@arbitrage/core', () => createCoreMocks(mockLogger, mockStateManager))
 */
export function createCoreMocks(
  mockLogger: MockLogger = createMockLogger(),
  mockStateManager: MockStateManager = createMockStateManager()
) {
  return {
    createLogger: jest.fn().mockReturnValue(mockLogger),
    parsePort: jest.fn().mockImplementation((portEnv: string | undefined, defaultPort: number) => {
      if (!portEnv) return defaultPort;
      const parsed = parseInt(portEnv, 10);
      return isNaN(parsed) || parsed < 1 || parsed > 65535 ? defaultPort : parsed;
    }),
    validateAndFilterChains: jest.fn().mockImplementation(
      (chainsEnv: string | undefined, defaultChains: readonly string[]) => {
        if (!chainsEnv) return [...defaultChains];
        return chainsEnv.split(',').map((c: string) => c.trim().toLowerCase());
      }
    ),
    createPartitionHealthServer: jest.fn().mockReturnValue({
      close: jest.fn((cb?: (err?: Error) => void) => cb && cb()),
      on: jest.fn(),
      listen: jest.fn(),
    }),
    setupDetectorEventHandlers: jest.fn(),
    setupProcessHandlers: jest.fn().mockReturnValue(jest.fn()), // Returns cleanup function
    getRedisClient: jest.fn().mockResolvedValue({
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    }),
    getRedisStreamsClient: jest.fn().mockResolvedValue({
      xadd: jest.fn().mockResolvedValue('stream-id'),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }),
    createServiceState: jest.fn().mockReturnValue(mockStateManager),
    getPerformanceLogger: jest.fn().mockReturnValue({
      logHealthCheck: jest.fn(),
      logOpportunityDetection: jest.fn(),
    }),
    getCrossRegionHealthManager: jest.fn().mockReturnValue({
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      removeAllListeners: jest.fn(),
    }),
    getGracefulDegradationManager: jest.fn().mockReturnValue({
      registerCapabilities: jest.fn(),
      triggerDegradation: jest.fn(),
    }),
    shutdownPartitionService: jest.fn().mockResolvedValue(undefined),
    SHUTDOWN_TIMEOUT_MS: 5000,
  };
}

// =============================================================================
// Config Module Mocks Factory
// =============================================================================

export interface PartitionConfigOptions {
  partitionId?: string;
  name?: string;
  chains?: string[];
  region?: string;
  provider?: string;
  resourceProfile?: string;
  priority?: number;
  maxMemoryMB?: number;
  enabled?: boolean;
  healthCheckIntervalMs?: number;
  failoverTimeoutMs?: number;
}

/**
 * Creates the mock implementation object for @arbitrage/config module.
 */
export function createConfigMocks(options: PartitionConfigOptions = {}) {
  const defaultConfig = {
    partitionId: options.partitionId || 'asia-fast',
    name: options.name || 'Asia Fast Chains',
    chains: options.chains || ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: options.region || 'asia-southeast1',
    provider: options.provider || 'oracle',
    resourceProfile: options.resourceProfile || 'heavy',
    priority: options.priority || 1,
    maxMemoryMB: options.maxMemoryMB || 768,
    enabled: options.enabled !== false,
    healthCheckIntervalMs: options.healthCheckIntervalMs || 15000,
    failoverTimeoutMs: options.failoverTimeoutMs || 60000,
  };

  return {
    getPartition: jest.fn().mockImplementation((partitionId: string) => ({
      ...defaultConfig,
      partitionId,
    })),
    getPartitionFromEnv: jest.fn().mockReturnValue(defaultConfig),
    getChainsFromEnv: jest.fn().mockReturnValue([...defaultConfig.chains]),
    PARTITION_IDS: {
      ASIA_FAST: 'asia-fast',
      L2_TURBO: 'l2-turbo',
      HIGH_VALUE: 'high-value',
      SOLANA_NATIVE: 'solana-native',
    },
    CHAINS: {
      bsc: { id: 56, name: 'BSC' },
      polygon: { id: 137, name: 'Polygon' },
      avalanche: { id: 43114, name: 'Avalanche' },
      fantom: { id: 250, name: 'Fantom' },
      arbitrum: { id: 42161, name: 'Arbitrum' },
      optimism: { id: 10, name: 'Optimism' },
      base: { id: 8453, name: 'Base' },
      ethereum: { id: 1, name: 'Ethereum' },
      zksync: { id: 324, name: 'zkSync' },
      linea: { id: 59144, name: 'Linea' },
      solana: { id: 0, name: 'Solana' },
    },
  };
}

// =============================================================================
// Unified Detector Module Mocks Factory
// =============================================================================

/**
 * Creates the mock implementation object for @arbitrage/unified-detector module.
 */
export function createUnifiedDetectorMocks(detectorInstance?: MockUnifiedChainDetector) {
  const detector = detectorInstance || new MockUnifiedChainDetector();

  return {
    UnifiedChainDetector: jest.fn().mockImplementation(() => detector),
  };
}

// =============================================================================
// HTTP Server Mock
// =============================================================================

export interface MockHttpServer {
  close: jest.Mock;
  on: jest.Mock;
  listen: jest.Mock;
}

/**
 * Creates a mock HTTP server for health check testing.
 */
export function createMockHttpServer(): MockHttpServer {
  return {
    close: jest.fn((cb?: (err?: Error) => void) => cb && cb()),
    on: jest.fn(),
    listen: jest.fn(),
  };
}

// =============================================================================
// Test Environment Setup
// =============================================================================

/**
 * Sets up common environment variables for partition service tests.
 * Should be called in beforeAll/beforeEach.
 */
export function setupPartitionTestEnv(overrides: Record<string, string> = {}): void {
  // Set JEST_WORKER_ID to prevent auto-start
  process.env.JEST_WORKER_ID = '1';
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6379';

  // Apply overrides
  Object.entries(overrides).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

/**
 * Cleans up environment variables after partition service tests.
 * Should be called in afterAll/afterEach.
 */
export function cleanupPartitionTestEnv(keysToRemove: string[] = []): void {
  const defaultKeys = ['PARTITION_ID', 'PARTITION_CHAINS', 'HEALTH_CHECK_PORT'];
  [...defaultKeys, ...keysToRemove].forEach(key => {
    delete process.env[key];
  });
}
