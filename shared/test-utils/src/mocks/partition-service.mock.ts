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
  fatal: jest.Mock;
  error: jest.Mock;
  warn: jest.Mock;
  info: jest.Mock;
  debug: jest.Mock;
  trace: jest.Mock;
  child: jest.Mock;
}

/**
 * Creates a mock logger with jest.fn() implementations for all log methods.
 */
export function createMockLogger(): MockLogger {
  const logger: MockLogger = {
    fatal: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(),
  };
  // child() returns a new mock logger with the same interface
  logger.child.mockReturnValue(logger);
  return logger;
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
    createPartitionEntry: jest.fn().mockImplementation((
      partitionId: string,
      createDetector: (cfg: unknown) => unknown,
      hooks?: {
        onStarted?: (detector: unknown, startupDurationMs: number) => void | Promise<void>;
        onStartupError?: (error: Error) => void | Promise<void>;
        additionalCleanup?: () => void;
      }
    ) => {
      const { getPartition } = require('@arbitrage/config');
      const partitionConfig = getPartition(partitionId);
      const chains: string[] = partitionConfig?.chains ?? [];
      const region: string = partitionConfig?.region ?? 'us-east1';
      const defaultPort = PORTS[partitionId] ?? 3000;
      const serviceName = DEFAULT_PARTITION_SERVICE_NAMES[partitionId] ?? `partition-${partitionId}`;

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
      const runnerCleanup = jest.fn();

      // Compose cleanup: standard runner cleanup + optional additional cleanup
      const composedCleanup = hooks?.additionalCleanup
        ? jest.fn().mockImplementation(() => {
            hooks.additionalCleanup!();
            runnerCleanup();
          })
        : runnerCleanup;

      const serviceConfig = {
        partitionId,
        serviceName,
        defaultChains: chains,
        defaultPort,
        region,
        provider: partitionConfig?.provider ?? 'oracle',
      };

      return {
        detector,
        config: detectorConfig,
        partitionId,
        chains,
        region,
        cleanupProcessHandlers: composedCleanup,
        envConfig,
        runner: {
          detector,
          start: jest.fn().mockResolvedValue(undefined),
          getState: jest.fn().mockReturnValue('idle'),
          cleanup: runnerCleanup,
          healthServer: { current: null },
        },
        serviceConfig,
        logger: mockLogger,
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

// =============================================================================
// Partition Detector Mock Factory
// =============================================================================

/**
 * Options for customizing createMockPartitionDetector behavior.
 */
export interface MockPartitionDetectorOptions {
  /** Partition ID (default: 'test-partition') */
  partitionId?: string;
  /** Chains the detector monitors (default: ['bsc', 'polygon']) */
  chains?: string[];
  /** Whether the detector starts in running state (default: false) */
  isRunning?: boolean;
  /** Health status to return (default: 'healthy') */
  healthStatus?: string;
}

/**
 * Return type of createMockPartitionDetector.
 *
 * All methods are jest.Mock instances for easy assertion and override.
 * Extends EventEmitter to support event-based testing (on/off/emit).
 */
export interface MockPartitionDetector extends EventEmitter {
  getPartitionHealth: jest.Mock;
  getHealthyChains: jest.Mock;
  getStats: jest.Mock;
  isRunning: jest.Mock;
  getPartitionId: jest.Mock;
  getChains: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
}

/**
 * Creates a mock partition detector with jest.fn() implementations.
 *
 * Unlike MockUnifiedChainDetector (which uses real method implementations),
 * this factory returns an object where every method is a jest.Mock, making
 * it easier to override return values and assert call counts in tests.
 *
 * The mock extends EventEmitter so on/off/emit work natively.
 *
 * @param options - Configuration for default return values
 * @returns Mock detector instance with jest.fn() methods
 *
 * @example
 * ```typescript
 * const detector = createMockPartitionDetector({ partitionId: 'asia-fast' });
 * detector.getHealthyChains.mockReturnValue(['bsc']);
 * expect(detector.getHealthyChains()).toEqual(['bsc']);
 * ```
 *
 * @see PartitionDetectorInterface in shared/core/src/partition-service-utils.ts
 */
export function createMockPartitionDetector(
  options: MockPartitionDetectorOptions = {}
): MockPartitionDetector {
  const partitionId = options.partitionId ?? 'test-partition';
  const chains = options.chains ?? ['bsc', 'polygon'];
  const running = options.isRunning ?? false;
  const healthStatus = options.healthStatus ?? 'healthy';

  const emitter = new EventEmitter() as MockPartitionDetector;

  emitter.getPartitionHealth = jest.fn().mockResolvedValue({
    status: healthStatus,
    partitionId,
    chainHealth: new Map(),
    uptimeSeconds: 0,
    totalEventsProcessed: 0,
    memoryUsage: 0,
  });

  emitter.getHealthyChains = jest.fn().mockReturnValue([...chains]);

  emitter.getStats = jest.fn().mockReturnValue({
    partitionId,
    chains: [...chains],
    totalEventsProcessed: 0,
    totalOpportunitiesFound: 0,
    uptimeSeconds: 0,
    memoryUsageMB: 0,
    chainStats: new Map(),
  });

  emitter.isRunning = jest.fn().mockReturnValue(running);
  emitter.getPartitionId = jest.fn().mockReturnValue(partitionId);
  emitter.getChains = jest.fn().mockReturnValue([...chains]);
  emitter.start = jest.fn().mockResolvedValue(undefined);
  emitter.stop = jest.fn().mockResolvedValue(undefined);

  return emitter;
}

// =============================================================================
// Health Server Mock Factory
// =============================================================================

/**
 * Return type of createMockHealthServer.
 *
 * Mimics the subset of http.Server used by partition services:
 * listen, close, on, address, and timeout properties.
 */
export interface MockHealthServer {
  listen: jest.Mock;
  close: jest.Mock;
  on: jest.Mock;
  address: jest.Mock;
  requestTimeout: number;
  headersTimeout: number;
  keepAliveTimeout: number;
  maxConnections: number;
}

/**
 * Creates a mock HTTP server matching the shape used by partition health servers.
 *
 * - listen() invokes its callback synchronously (simulating immediate bind).
 * - close() invokes its callback synchronously (simulating immediate close).
 * - on() is a no-op mock for attaching error handlers.
 * - address() returns a mock address object.
 * - Timeout properties match the values set by createPartitionHealthServer.
 *
 * @returns Mock health server instance
 *
 * @example
 * ```typescript
 * const server = createMockHealthServer();
 * server.listen(3001, '0.0.0.0', () => console.log('listening'));
 * expect(server.listen).toHaveBeenCalledWith(3001, '0.0.0.0', expect.any(Function));
 * ```
 *
 * @see createPartitionHealthServer in shared/core/src/partition-service-utils.ts
 */
export function createMockHealthServer(): MockHealthServer {
  return {
    listen: jest.fn().mockImplementation(
      (_port: number, _host?: string | (() => void), cb?: () => void) => {
        // Support both listen(port, cb) and listen(port, host, cb) signatures
        const callback = typeof _host === 'function' ? _host : cb;
        if (callback) callback();
      }
    ),
    close: jest.fn().mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) cb();
    }),
    on: jest.fn(),
    address: jest.fn().mockReturnValue({ port: 3000, family: 'IPv4', address: '0.0.0.0' }),
    requestTimeout: 5000,
    headersTimeout: 3000,
    keepAliveTimeout: 5000,
    maxConnections: 100,
  };
}

// =============================================================================
// Partition Entry Mock Factory
// =============================================================================

/**
 * Options for customizing createMockPartitionEntry behavior.
 */
export interface MockPartitionEntryOptions {
  /** Partition ID (default: 'test') */
  partitionId?: string;
  /** Chains for this partition (default: ['bsc', 'polygon']) */
  chains?: string[];
  /** Region (default: 'us-east1') */
  region?: string;
  /** Health check port (default: 3001) */
  healthCheckPort?: number;
  /** Instance ID (default: 'test-local-1234567890') */
  instanceId?: string;
  /** Region ID for detector config (default: same as region) */
  regionId?: string;
  /** Enable cross-region health (default: true) */
  enableCrossRegionHealth?: boolean;
  /** Node environment (default: 'test') */
  nodeEnv?: string;
  /** Override detector mock (default: createMockPartitionDetector()) */
  detector?: MockPartitionDetector;
  /** Override health server mock (default: createMockHealthServer()) */
  healthServer?: MockHealthServer;
}

/**
 * Return type of createMockPartitionEntry.
 *
 * Matches the shape of PartitionEntryResult from partition-service-utils.ts,
 * with all nested objects using jest.fn() mocks for easy assertion.
 */
export interface MockPartitionEntry {
  /** Mock detector instance */
  detector: MockPartitionDetector;
  /** Detector configuration */
  config: {
    partitionId: string;
    chains: string[];
    instanceId: string;
    regionId: string;
    enableCrossRegionHealth: boolean;
    healthCheckPort: number;
  };
  /** Partition ID constant */
  partitionId: string;
  /** Configured chains */
  chains: readonly string[];
  /** Deployment region */
  region: string;
  /** Process handler cleanup function (jest.fn) */
  cleanupProcessHandlers: jest.Mock;
  /** Parsed environment configuration */
  envConfig: {
    redisUrl: string | undefined;
    partitionChains: string | undefined;
    healthCheckPort: string | undefined;
    instanceId: string | undefined;
    regionId: string | undefined;
    enableCrossRegionHealth: boolean;
    nodeEnv: string;
    rpcUrls: Record<string, string | undefined>;
    wsUrls: Record<string, string | undefined>;
  };
  /** Full runner instance */
  runner: {
    detector: MockPartitionDetector;
    start: jest.Mock;
    getState: jest.Mock;
    cleanup: jest.Mock;
    healthServer: { current: MockHealthServer | null };
  };
}

/**
 * Creates a complete mock of the createPartitionEntry() factory output.
 *
 * Returns all fields from PartitionEntryResult with sensible test defaults.
 * All function-typed fields are jest.fn() mocks for easy assertion.
 *
 * This is the preferred way to mock the partition entry in tests that
 * need to verify behavior after the factory has run, without pulling
 * in the full createCoreMocks + createConfigMocks setup.
 *
 * @param options - Configuration overrides
 * @returns Complete mock of PartitionEntryResult
 *
 * @example
 * ```typescript
 * const entry = createMockPartitionEntry({ partitionId: 'asia-fast', chains: ['bsc'] });
 * expect(entry.config.partitionId).toBe('asia-fast');
 * expect(entry.detector.getHealthyChains()).toEqual(['bsc']);
 * entry.runner.start();
 * expect(entry.runner.start).toHaveBeenCalled();
 * ```
 *
 * @see PartitionEntryResult in shared/core/src/partition-service-utils.ts
 * @see createPartitionEntry in shared/core/src/partition-service-utils.ts
 */
export function createMockPartitionEntry(
  options: MockPartitionEntryOptions = {}
): MockPartitionEntry {
  const partitionId = options.partitionId ?? 'test';
  const chains = options.chains ?? ['bsc', 'polygon'];
  const region = options.region ?? 'us-east1';
  const healthCheckPort = options.healthCheckPort ?? 3001;
  const instanceId = options.instanceId ?? `${partitionId}-local-1234567890`;
  const regionId = options.regionId ?? region;
  const enableCrossRegionHealth = options.enableCrossRegionHealth ?? true;
  const nodeEnv = options.nodeEnv ?? 'test';

  const detector = options.detector ?? createMockPartitionDetector({
    partitionId,
    chains,
  });

  const healthServer = options.healthServer ?? createMockHealthServer();

  const config = {
    partitionId,
    chains: [...chains],
    instanceId,
    regionId,
    enableCrossRegionHealth,
    healthCheckPort,
  };

  const envConfig = {
    redisUrl: process.env.REDIS_URL,
    partitionChains: undefined as string | undefined,
    healthCheckPort: undefined as string | undefined,
    instanceId: undefined as string | undefined,
    regionId: undefined as string | undefined,
    enableCrossRegionHealth,
    nodeEnv,
    rpcUrls: Object.fromEntries(chains.map(c => [c, undefined])) as Record<string, string | undefined>,
    wsUrls: Object.fromEntries(chains.map(c => [c, undefined])) as Record<string, string | undefined>,
  };

  const cleanupProcessHandlers = jest.fn();

  const runner = {
    detector,
    start: jest.fn().mockResolvedValue(undefined),
    getState: jest.fn().mockReturnValue('idle' as const),
    cleanup: jest.fn(),
    healthServer: { current: healthServer },
  };

  return {
    detector,
    config,
    partitionId,
    chains,
    region,
    cleanupProcessHandlers,
    envConfig,
    runner,
  };
}

