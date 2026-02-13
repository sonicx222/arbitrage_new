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
 *
 * Accepts either MockDetectorOptions or a generic config object (as passed by
 * partition services via `new UnifiedChainDetector(config)`), making it usable
 * both as a direct mock and as a jest.mock constructor replacement.
 */
export class MockUnifiedChainDetector extends EventEmitter {
  private partitionId: string;
  private chains: string[];
  private running: boolean;

  constructor(options: MockDetectorOptions | Record<string, unknown> = {}) {
    super();
    const opts = options as Record<string, unknown>;
    this.partitionId = (opts.partitionId as string) ?? 'test-partition';
    this.chains = (opts.chains as string[]) ?? ['bsc', 'polygon'];
    this.running = (opts.isRunning as boolean) ?? false;
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
      status: this.running ? 'healthy' : 'starting',
      partitionId: this.partitionId,
      chainHealth: new Map(),
      totalEventsProcessed: 0,
      avgEventLatencyMs: 0,
      memoryUsage: 0,
      cpuUsage: 0,
      uptimeSeconds: 0,
      lastHealthCheck: Date.now(),
      activeOpportunities: 0,
    };
  }

  getStats() {
    return {
      partitionId: this.partitionId,
      chains: this.chains,
      totalEventsProcessed: 0,
      totalOpportunitiesFound: 0,
      uptimeSeconds: 0,
      memoryUsageMB: 0,
      chainStats: new Map(),
    };
  }
}

// =============================================================================
// Core Module Mocks Factory
// =============================================================================

/**
 * Options for customizing createCoreMocks behavior.
 */
export interface CoreMocksOptions {
  /**
   * When true, the createPartitionEntry mock calls validatePartitionEnvironmentConfig
   * with full production-validation logic (for integration tests).
   * When false (default), validatePartitionEnvironmentConfig is a simple no-op mock.
   */
  includeValidation?: boolean;

  /**
   * Port mapping overrides. Defaults to standard partition ports.
   */
  ports?: Record<string, number>;
}

/** Default partition port mapping */
const DEFAULT_PARTITION_PORTS: Record<string, number> = {
  'asia-fast': 3001,
  'l2-turbo': 3002,
  'high-value': 3003,
  'solana-native': 3004,
};

/** Default partition service name mapping */
const DEFAULT_PARTITION_SERVICE_NAMES: Record<string, string> = {
  'asia-fast': 'partition-asia-fast',
  'l2-turbo': 'partition-l2-turbo',
  'high-value': 'partition-high-value',
  'solana-native': 'partition-solana',
};

/**
 * Creates the mock implementation object for @arbitrage/core module.
 *
 * Includes all functions that partition services import from @arbitrage/core:
 * - createLogger, parsePort, validateAndFilterChains
 * - createPartitionHealthServer, setupDetectorEventHandlers, setupProcessHandlers
 * - exitWithConfigError, closeServerWithTimeout
 * - parsePartitionEnvironmentConfig, validatePartitionEnvironmentConfig, generateInstanceId
 * - getRedisClient, getRedisStreamsClient, createServiceState
 * - getPerformanceLogger, getCrossRegionHealthManager, getGracefulDegradationManager
 * - shutdownPartitionService, SHUTDOWN_TIMEOUT_MS
 * - PARTITION_PORTS, PARTITION_SERVICE_NAMES
 * - runPartitionService, createPartitionServiceRunner, createPartitionEntry
 *
 * Use with jest.mock('@arbitrage/core', () => createCoreMocks(mockLogger, mockStateManager))
 */
export function createCoreMocks(
  mockLogger: MockLogger = createMockLogger(),
  mockStateManager: MockStateManager = createMockStateManager(),
  options: CoreMocksOptions = {}
) {
  const PORTS = options.ports ?? DEFAULT_PARTITION_PORTS;

  const mockValidateEnvConfig = options.includeValidation
    ? jest.fn().mockImplementation(
        (envConfig: Record<string, unknown>, partitionId: string, chainNames: string[], logger: MockLogger | null) => {
          if (envConfig.nodeEnv === 'production') {
            const rpcUrls = (envConfig.rpcUrls ?? {}) as Record<string, string | undefined>;
            const wsUrls = (envConfig.wsUrls ?? {}) as Record<string, string | undefined>;
            const missingRpcUrls: string[] = [];
            const missingWsUrls: string[] = [];
            for (const chain of chainNames) {
              const upperChain = chain.toUpperCase();
              if (!rpcUrls[chain]) {
                missingRpcUrls.push(`${upperChain}_RPC_URL`);
              }
              if (!wsUrls[chain]) {
                missingWsUrls.push(`${upperChain}_WS_URL`);
              }
            }
            if (missingRpcUrls.length > 0 && logger) {
              logger.warn('Production deployment without custom RPC URLs - public endpoints may have rate limits', {
                partitionId,
                missingRpcUrls,
                hint: 'Configure private RPC endpoints (Alchemy, Infura, QuickNode) for production reliability'
              });
            }
            if (missingWsUrls.length > 0 && logger) {
              logger.warn('Production deployment without custom WebSocket URLs - public endpoints may be unreliable', {
                partitionId,
                missingWsUrls,
                hint: 'Configure private WebSocket endpoints for production reliability'
              });
            }
          }
        }
      )
    : jest.fn();

  return {
    createLogger: jest.fn().mockReturnValue(mockLogger),
    parsePort: jest.fn().mockImplementation((portEnv: string | undefined, defaultPort: number) => {
      if (!portEnv) return defaultPort;
      const parsed = parseInt(portEnv, 10);
      return isNaN(parsed) || parsed < 1 || parsed > 65535 ? defaultPort : parsed;
    }),
    validateAndFilterChains: jest.fn().mockImplementation(
      (chainsEnv: string | undefined, defaultChains: readonly string[], logger?: unknown) => {
        if (!chainsEnv) return [...defaultChains];
        const requested = chainsEnv.split(',').map((c: string) => c.trim().toLowerCase());
        const knownChainIds = Object.keys(ALL_CHAINS);
        const validChains: string[] = [];
        const invalidChains: string[] = [];
        for (const chain of requested) {
          if (knownChainIds.includes(chain)) {
            validChains.push(chain);
          } else {
            invalidChains.push(chain);
          }
        }
        if (invalidChains.length > 0 && logger && typeof (logger as Record<string, unknown>).warn === 'function') {
          (logger as { warn: (msg: string, ctx: Record<string, unknown>) => void }).warn(
            'Invalid chain IDs in PARTITION_CHAINS, ignoring',
            { invalidChains, validChains, availableChains: knownChainIds }
          );
        }
        if (validChains.length === 0) {
          if (logger && typeof (logger as Record<string, unknown>).warn === 'function') {
            (logger as { warn: (msg: string, ctx: Record<string, unknown>) => void }).warn(
              'No valid chains in PARTITION_CHAINS, using defaults',
              { defaults: defaultChains }
            );
          }
          return [...defaultChains];
        }
        return [...new Set(validChains)];
      }
    ),
    createPartitionHealthServer: jest.fn().mockReturnValue({
      close: jest.fn((cb?: (err?: Error) => void) => cb && cb()),
      on: jest.fn(),
      listen: jest.fn(),
    }),
    setupDetectorEventHandlers: jest.fn().mockReturnValue(jest.fn()), // Returns cleanup function (FIX #9)
    setupProcessHandlers: jest.fn().mockReturnValue(jest.fn()), // Returns cleanup function
    exitWithConfigError: jest.fn().mockImplementation((msg: string) => {
      throw new Error(`Config error: ${msg}`);
    }),
    closeServerWithTimeout: jest.fn().mockResolvedValue(undefined),
    parsePartitionEnvironmentConfig: jest.fn().mockImplementation((chainNames: readonly string[]) => ({
      redisUrl: process.env.REDIS_URL,
      partitionChains: process.env.PARTITION_CHAINS,
      healthCheckPort: process.env.HEALTH_CHECK_PORT,
      instanceId: process.env.INSTANCE_ID,
      regionId: process.env.REGION_ID,
      enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
      nodeEnv: process.env.NODE_ENV ?? 'development',
      rpcUrls: Object.fromEntries(chainNames.map(c => [c, process.env[`${c.toUpperCase()}_RPC_URL`]])),
      wsUrls: Object.fromEntries(chainNames.map(c => [c, process.env[`${c.toUpperCase()}_WS_URL`]])),
    })),
    validatePartitionEnvironmentConfig: mockValidateEnvConfig,
    generateInstanceId: jest.fn().mockImplementation((partitionId: string, providedId?: string) => {
      if (providedId) return providedId;
      return `${partitionId}-${process.env.HOSTNAME ?? 'local'}-${Date.now()}`;
    }),
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
    PARTITION_PORTS: PORTS,
    PARTITION_SERVICE_NAMES: { ...DEFAULT_PARTITION_SERVICE_NAMES },
    PartitionServiceConfig: {},
    runPartitionService: jest.fn().mockImplementation((opts: {
      createDetector: (cfg: unknown) => unknown;
      detectorConfig: unknown;
    }) => ({
      detector: opts.createDetector(opts.detectorConfig),
      start: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn().mockReturnValue('idle'),
      cleanup: jest.fn(),
      healthServer: { current: null },
    })),
    createPartitionServiceRunner: jest.fn().mockImplementation((opts: {
      createDetector: (cfg: unknown) => unknown;
      detectorConfig: unknown;
    }) => ({
      detector: opts.createDetector(opts.detectorConfig),
      start: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn().mockReturnValue('idle'),
      cleanup: jest.fn(),
      healthServer: { current: null },
    })),
    createPartitionEntry: jest.fn().mockImplementation((partitionId: string, createDetector: (cfg: unknown) => unknown) => {
      const { getPartition } = require('@arbitrage/config');
      const partitionConfig = getPartition(partitionId);
      const chains: string[] = partitionConfig?.chains ?? [];
      const region: string = partitionConfig?.region ?? 'us-east1';
      const defaultPort = PORTS[partitionId] ?? 3000;

      const envConfig = {
        redisUrl: process.env.REDIS_URL,
        partitionChains: process.env.PARTITION_CHAINS,
        healthCheckPort: process.env.HEALTH_CHECK_PORT,
        instanceId: process.env.INSTANCE_ID,
        regionId: process.env.REGION_ID,
        enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
        nodeEnv: process.env.NODE_ENV ?? 'development',
        rpcUrls: Object.fromEntries(chains.map((c: string) => [c, process.env[`${c.toUpperCase()}_RPC_URL`]])),
        wsUrls: Object.fromEntries(chains.map((c: string) => [c, process.env[`${c.toUpperCase()}_WS_URL`]])),
      };

      // Call validatePartitionEnvironmentConfig if includeValidation is enabled
      if (options.includeValidation) {
        mockValidateEnvConfig(envConfig, partitionId, chains, mockLogger);
      }

      const instanceId = envConfig.instanceId
        ?? `${partitionId}-${process.env.HOSTNAME ?? 'local'}-${Date.now()}`;
      const healthCheckPort = envConfig.healthCheckPort
        ? (parseInt(envConfig.healthCheckPort, 10) || defaultPort)
        : defaultPort;

      // Handle PARTITION_CHAINS env var filtering
      let resolvedChains = [...chains];
      if (envConfig.partitionChains) {
        resolvedChains = envConfig.partitionChains.split(',').map((c: string) => c.trim().toLowerCase());
      }

      const detectorConfig = {
        partitionId,
        chains: resolvedChains,
        instanceId,
        regionId: envConfig.regionId ?? region,
        enableCrossRegionHealth: envConfig.enableCrossRegionHealth ?? true,
        healthCheckPort,
      };

      const detector = createDetector(detectorConfig);

      return {
        detector,
        config: detectorConfig,
        partitionId,
        chains,
        region,
        cleanupProcessHandlers: jest.fn(),
        envConfig,
        runner: {
          detector,
          start: jest.fn().mockResolvedValue(undefined),
          getState: jest.fn().mockReturnValue('idle'),
          cleanup: jest.fn(),
          healthServer: { current: null },
        },
      };
    }),
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
  /** Additional partition config fields (e.g., standbyRegion, standbyProvider) */
  extra?: Record<string, unknown>;
  /**
   * When set, only include these chain IDs in the CHAINS mock.
   * Defaults to all chains when not specified.
   */
  chainsSubset?: string[];
}

/** Full chain data for all supported chains */
const ALL_CHAINS: Record<string, Record<string, unknown>> = {
  bsc: { id: 56, name: 'BSC' },
  polygon: { id: 137, name: 'Polygon' },
  avalanche: { id: 43114, name: 'Avalanche' },
  fantom: { id: 250, name: 'Fantom' },
  arbitrum: { id: 42161, name: 'Arbitrum' },
  optimism: { id: 10, name: 'Optimism' },
  base: { id: 8453, name: 'Base' },
  ethereum: { id: 1, name: 'Ethereum', blockTime: 12 },
  zksync: { id: 324, name: 'zkSync Era', blockTime: 1 },
  linea: { id: 59144, name: 'Linea', blockTime: 2 },
  solana: { id: 0, name: 'Solana' },
};

/**
 * Creates the mock implementation object for @arbitrage/config module.
 *
 * Supports per-partition CHAINS subsets via `chainsSubset` option. When set,
 * the CHAINS mock only includes the specified chains (matching what the real
 * config module exposes for that partition's scope).
 */
export function createConfigMocks(options: PartitionConfigOptions = {}) {
  const defaultConfig = {
    partitionId: options.partitionId ?? 'asia-fast',
    name: options.name ?? 'Asia Fast Chains',
    chains: options.chains ?? ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: options.region ?? 'asia-southeast1',
    provider: options.provider ?? 'oracle',
    resourceProfile: options.resourceProfile ?? 'heavy',
    priority: options.priority ?? 1,
    maxMemoryMB: options.maxMemoryMB ?? 768,
    enabled: options.enabled !== false,
    healthCheckIntervalMs: options.healthCheckIntervalMs ?? 15000,
    failoverTimeoutMs: options.failoverTimeoutMs ?? 60000,
    ...(options.extra ?? {}),
  };

  // Build CHAINS subset if specified
  const chainsData = options.chainsSubset
    ? Object.fromEntries(
        options.chainsSubset
          .filter(id => id in ALL_CHAINS)
          .map(id => [id, ALL_CHAINS[id]])
      )
    : { ...ALL_CHAINS };

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
    CHAINS: chainsData,
  };
}

