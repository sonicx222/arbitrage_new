/**
 * Unit Tests for P4 Solana-Native Partition Service Entry Point
 *
 * Tests partition-specific configuration, RPC selection logic,
 * environment validation, event wiring, and cleanup.
 *
 * P4 now uses createPartitionEntry() factory (matching P1-P3 pattern)
 * with lifecycle hooks for Solana-specific initialization.
 *
 * @see ADR-003: Partitioned Chain Detectors (Factory Pattern)
 */

import { EventEmitter } from 'events';
import {
  MockUnifiedChainDetector,
  createMockLogger,
  createMockStateManager,
  createCoreMocks,
  createConfigMocks,
} from '@arbitrage/test-utils/mocks/partition-service.mock';

// =============================================================================
// Mock Instances (created before jest.mock calls)
// =============================================================================

const mockLogger = createMockLogger();
const mockStateManager = createMockStateManager();

// Mock SolanaArbitrageDetector — uses EventEmitter so .on() actually registers
// handlers, allowing event handler tests to work correctly.
class MockSolanaArbitrageDetector extends EventEmitter {
  start = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue(undefined);
  isRunning = jest.fn().mockReturnValue(false);
  connectToSolanaDetector = jest.fn();
  setStreamsClient = jest.fn();
  publishOpportunity = jest.fn().mockResolvedValue(undefined);
}

let mockSolanaArbitrageInstance: MockSolanaArbitrageDetector;

// =============================================================================
// Module Mocks (must be defined before any imports of the module under test)
// =============================================================================

jest.mock('@arbitrage/core', () => createCoreMocks(mockLogger, mockStateManager));

// Mock sub-entry points used by source imports (immune to resetMocks via plain functions)
jest.mock('@arbitrage/core/partition', () => {
  const PORTS: Record<string, number> = { 'asia-fast': 3001, 'l2-turbo': 3002, 'high-value': 3003, 'solana-native': 3004 };
  const SERVICE_NAMES: Record<string, string> = { 'asia-fast': 'partition-asia-fast', 'l2-turbo': 'partition-l2-turbo', 'high-value': 'partition-high-value', 'solana-native': 'partition-solana' };

  const _createPartitionEntryCalls: any[][] = [];

  function createPartitionEntry(
    partitionId: string,
    createDetector: (cfg: unknown) => unknown,
    hooks?: { onStarted?: Function; onStartupError?: Function; additionalCleanup?: () => void }
  ) {
    _createPartitionEntryCalls.push([partitionId, createDetector, hooks]);
    const { getPartition } = require('@arbitrage/config');
    const partitionConfig = getPartition(partitionId);
    const chains: string[] = partitionConfig?.chains ?? [];
    const region: string = partitionConfig?.region ?? 'us-east1';
    const defaultPort = PORTS[partitionId] ?? 3000;
    const serviceName = SERVICE_NAMES[partitionId] ?? `partition-${partitionId}`;

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

    const instanceId = envConfig.instanceId ?? `${partitionId}-${process.env.HOSTNAME ?? 'local'}-${Date.now()}`;
    const healthCheckPort = envConfig.healthCheckPort ? (parseInt(envConfig.healthCheckPort, 10) || defaultPort) : defaultPort;

    let resolvedChains = [...chains];
    if (envConfig.partitionChains) {
      resolvedChains = envConfig.partitionChains.split(',').map((c: string) => c.trim().toLowerCase());
    }

    const detectorConfig = {
      partitionId, chains: resolvedChains, instanceId,
      regionId: envConfig.regionId ?? region,
      enableCrossRegionHealth: envConfig.enableCrossRegionHealth ?? true,
      healthCheckPort,
    };

    const detector = createDetector(detectorConfig);

    // Compose cleanup: standard runner cleanup + optional additional cleanup from hooks
    const cleanupProcessHandlers = hooks?.additionalCleanup
      ? () => { hooks.additionalCleanup!(); }
      : () => {};

    return {
      detector, config: detectorConfig, partitionId, chains, region,
      cleanupProcessHandlers,
      envConfig,
      runner: { detector, start: async () => {}, getState: () => 'idle', cleanup: () => {}, healthServer: { current: null } },
      serviceConfig: { partitionId, serviceName, defaultChains: chains, defaultPort, region, provider: partitionConfig?.provider ?? 'oracle' },
      logger: mockLogger,
    };
  }

  // Attach calls tracker for test assertions
  (createPartitionEntry as any)._calls = _createPartitionEntryCalls;

  return {
    createPartitionEntry,
    parsePartitionEnvironmentConfig: (chainNames: readonly string[]) => ({
      redisUrl: process.env.REDIS_URL,
      partitionChains: process.env.PARTITION_CHAINS,
      healthCheckPort: process.env.HEALTH_CHECK_PORT,
      instanceId: process.env.INSTANCE_ID,
      regionId: process.env.REGION_ID,
      enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false',
      nodeEnv: process.env.NODE_ENV ?? 'development',
      rpcUrls: Object.fromEntries([...chainNames].map(c => [c, process.env[`${c.toUpperCase()}_RPC_URL`]])),
      wsUrls: Object.fromEntries([...chainNames].map(c => [c, process.env[`${c.toUpperCase()}_WS_URL`]])),
    }),
    validatePartitionEnvironmentConfig: () => {},
    validateAndFilterChains: (chainsEnv: string | undefined, defaultChains: readonly string[]) => {
      if (!chainsEnv) return [...defaultChains];
      return chainsEnv.split(',').map((c: string) => c.trim().toLowerCase());
    },
    generateInstanceId: (pid: string, id?: string) => id ?? `${pid}-${process.env.HOSTNAME ?? 'local'}-${Date.now()}`,
    exitWithConfigError: (msg: string) => { throw new Error(msg); },
    PARTITION_PORTS: PORTS,
    PARTITION_SERVICE_NAMES: SERVICE_NAMES,
  };
});

jest.mock('@arbitrage/core/redis', () => ({
  getRedisStreamsClient: async () => ({
    xadd: jest.fn().mockResolvedValue('stream-id'),
    disconnect: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: (e: unknown) => e instanceof Error ? e.message : String(e),
}));

jest.mock('@arbitrage/config', () => createConfigMocks({
  partitionId: 'solana-native',
  name: 'Solana Native',
  chains: ['solana'],
  region: 'us-west1',
  provider: 'oracle',
  resourceProfile: 'heavy',
  priority: 4,
  maxMemoryMB: 768,
  healthCheckIntervalMs: 10000,
  failoverTimeoutMs: 45000,
  chainsSubset: ['solana'],
}));

jest.mock('@arbitrage/unified-detector', () => ({
  UnifiedChainDetector: MockUnifiedChainDetector,
}));

jest.mock('../../src/arbitrage-detector', () => ({
  SolanaArbitrageDetector: jest.fn().mockImplementation(() => {
    mockSolanaArbitrageInstance = new MockSolanaArbitrageDetector();
    return mockSolanaArbitrageInstance;
  }),
}));

// =============================================================================
// Helpers
// =============================================================================

const originalEnv = process.env;

/** Import the module fresh with current env vars */
async function importIndexModule() {
  return await import('../../src/index');
}

/** Set up clean env with JEST_WORKER_ID guard */
function setupTestEnv(overrides: Record<string, string> = {}): void {
  process.env = {
    ...originalEnv,
    JEST_WORKER_ID: 'test',
    NODE_ENV: 'test',
    ...overrides,
  };
}

/** Delete all optional Solana env vars for a clean baseline */
function clearSolanaEnvVars(): void {
  delete process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_DEVNET_RPC_URL;
  delete process.env.HELIUS_API_KEY;
  delete process.env.TRITON_API_KEY;
  delete process.env.PARTITION_CHAINS;
  delete process.env.MIN_PROFIT_THRESHOLD;
  delete process.env.CROSS_CHAIN_ENABLED;
  delete process.env.TRIANGULAR_ENABLED;
  delete process.env.MAX_TRIANGULAR_DEPTH;
  delete process.env.OPPORTUNITY_EXPIRY_MS;
  delete process.env.REGION_ID;
  delete process.env.INSTANCE_ID;
  delete process.env.ENABLE_CROSS_REGION_HEALTH;
  delete process.env.HEALTH_CHECK_PORT;
}

/** Re-setup mock implementations that resetMocks: true clears between tests */
function resetMockImplementations(): void {
  mockLogger.info.mockImplementation(() => {});
  mockLogger.error.mockImplementation(() => {});
  mockLogger.warn.mockImplementation(() => {});
  mockLogger.debug.mockImplementation(() => {});
}

// =============================================================================
// Tests: Module Exports & Initialization
// =============================================================================

describe('P4 Solana-Native Partition Service - index.ts', () => {
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Module Exports
  // ---------------------------------------------------------------------------

  describe('Module Exports', () => {
    it('should export detector instance', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.detector).toBeDefined();
      expect(typeof mod.detector.start).toBe('function');
      expect(typeof mod.detector.stop).toBe('function');
    });

    it('should export solanaArbitrageDetector instance', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.solanaArbitrageDetector).toBeDefined();
      expect(typeof mod.solanaArbitrageDetector.start).toBe('function');
      expect(typeof mod.solanaArbitrageDetector.stop).toBe('function');
    });

    it('should export config object with partitionId solana-native', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.config).toBeDefined();
      expect(mod.config.partitionId).toBe('solana-native');
    });

    it('should export arbitrageConfig object', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.arbitrageConfig).toBeDefined();
      expect(mod.arbitrageConfig).toHaveProperty('minProfitThreshold');
      expect(mod.arbitrageConfig).toHaveProperty('crossChainEnabled');
      expect(mod.arbitrageConfig).toHaveProperty('triangularEnabled');
    });

    it('should export P4_PARTITION_ID as solana-native', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.P4_PARTITION_ID).toBe('solana-native');
    });

    it('should export P4_CHAINS containing solana', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.P4_CHAINS).toContain('solana');
    });

    it('should export P4_REGION as us-west1', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.P4_REGION).toBe('us-west1');
    });

    it('should export cleanupProcessHandlers as a function', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(typeof mod.cleanupProcessHandlers).toBe('function');
    });

    it('should export selectSolanaRpcUrl as a function', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(typeof mod.selectSolanaRpcUrl).toBe('function');
    });

    it('should export isDevnetMode as a function', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(typeof mod.isDevnetMode).toBe('function');
    });

    it('should export rpcSelection with url, provider, and isPublicEndpoint', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection).toHaveProperty('url');
      expect(mod.rpcSelection).toHaveProperty('provider');
      expect(mod.rpcSelection).toHaveProperty('isPublicEndpoint');
    });

    it('should export SOLANA_RPC_PROVIDERS with mainnet and devnet', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.SOLANA_RPC_PROVIDERS.mainnet).toHaveProperty('helius');
      expect(mod.SOLANA_RPC_PROVIDERS.mainnet).toHaveProperty('triton');
      expect(mod.SOLANA_RPC_PROVIDERS.mainnet).toHaveProperty('publicNode');
      expect(mod.SOLANA_RPC_PROVIDERS.devnet).toHaveProperty('helius');
      expect(mod.SOLANA_RPC_PROVIDERS.devnet).toHaveProperty('publicNode');
    });
  });

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  describe('Initialization', () => {
    it('should call createLogger with partition-solana namespace', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      const { createLogger } = jest.requireMock('@arbitrage/core');
      expect(createLogger).toHaveBeenCalledWith('partition-solana:main');
    });

    it('should call createPartitionEntry with solana-native ID', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      const { createPartitionEntry } = jest.requireMock('@arbitrage/core/partition');
      // Plain function tracks calls via _calls array (immune to resetMocks)
      const calls = (createPartitionEntry as any)._calls;
      const matchingCall = calls.find((c: any[]) => c[0] === 'solana-native');
      expect(matchingCall).toBeDefined();
      expect(typeof matchingCall[1]).toBe('function');
      expect(matchingCall[2]).toEqual(expect.objectContaining({
        onStarted: expect.any(Function),
        onStartupError: expect.any(Function),
        additionalCleanup: expect.any(Function),
      }));
    });

    it('should call connectToSolanaDetector on arbitrage detector', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mockSolanaArbitrageInstance.connectToSolanaDetector).toHaveBeenCalledWith(
        mod.detector
      );
    });

    it('should not auto-start main() when JEST_WORKER_ID is set', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      // If main() ran, detector.start() would have been called
      expect(mod.detector.isRunning()).toBe(false);
    });
  });
});

// =============================================================================
// Tests: selectSolanaRpcUrl()
// =============================================================================

describe('selectSolanaRpcUrl()', () => {
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Priority 1: Explicit URL
  // ---------------------------------------------------------------------------

  describe('Priority 1: Explicit URL', () => {
    it('should select SOLANA_RPC_URL when set for mainnet', async () => {
      process.env.SOLANA_RPC_URL = 'https://custom-rpc.example.com';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://custom-rpc.example.com');
      expect(mod.rpcSelection.provider).toBe('explicit');
      expect(mod.rpcSelection.isPublicEndpoint).toBe(false);
    });

    it('should select SOLANA_DEVNET_RPC_URL when in devnet mode', async () => {
      process.env.PARTITION_CHAINS = 'solana-devnet';
      process.env.SOLANA_DEVNET_RPC_URL = 'https://devnet-custom.example.com';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://devnet-custom.example.com');
      expect(mod.rpcSelection.provider).toBe('explicit');
    });

    it('should ignore SOLANA_RPC_URL when in devnet mode without SOLANA_DEVNET_RPC_URL', async () => {
      process.env.PARTITION_CHAINS = 'solana-devnet';
      process.env.SOLANA_RPC_URL = 'https://mainnet.example.com';
      // No SOLANA_DEVNET_RPC_URL set
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      // Should fall through to lower priority (not 'explicit')
      expect(mod.rpcSelection.provider).not.toBe('explicit');
    });
  });

  // ---------------------------------------------------------------------------
  // Priority 2: Helius
  // ---------------------------------------------------------------------------

  describe('Priority 2: Helius', () => {
    it('should construct Helius mainnet URL from HELIUS_API_KEY', async () => {
      process.env.HELIUS_API_KEY = 'test-helius-key-123';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://mainnet.helius-rpc.com/?api-key=test-helius-key-123');
      expect(mod.rpcSelection.provider).toBe('helius');
      expect(mod.rpcSelection.isPublicEndpoint).toBe(false);
    });

    it('should construct Helius devnet URL when in devnet mode', async () => {
      process.env.HELIUS_API_KEY = 'test-helius-key-123';
      process.env.PARTITION_CHAINS = 'solana-devnet';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://devnet.helius-rpc.com/?api-key=test-helius-key-123');
    });

    it('should not select Helius when HELIUS_API_KEY is empty string', async () => {
      process.env.HELIUS_API_KEY = '';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      // Empty string is falsy, falls through
      expect(mod.rpcSelection.provider).not.toBe('helius');
    });
  });

  // ---------------------------------------------------------------------------
  // Priority 3: Triton
  // ---------------------------------------------------------------------------

  describe('Priority 3: Triton', () => {
    it('should construct Triton mainnet URL from TRITON_API_KEY', async () => {
      process.env.TRITON_API_KEY = 'abc123def456';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://solana-mainnet.rpc.extrnode.com/abc123def456');
      expect(mod.rpcSelection.provider).toBe('triton');
      expect(mod.rpcSelection.isPublicEndpoint).toBe(false);
    });

    it('should construct Triton devnet URL when in devnet mode', async () => {
      process.env.TRITON_API_KEY = 'abc123def456';
      process.env.PARTITION_CHAINS = 'solana-devnet';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://solana-devnet.rpc.extrnode.com/abc123def456');
    });

    it('should not select Triton when TRITON_API_KEY is empty string', async () => {
      process.env.TRITON_API_KEY = '';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.provider).not.toBe('triton');
    });
  });

  // ---------------------------------------------------------------------------
  // Priority 4: PublicNode Fallback
  // ---------------------------------------------------------------------------

  describe('Priority 4: PublicNode fallback', () => {
    it('should fall back to PublicNode mainnet when no API keys are set', async () => {
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://solana-mainnet.rpc.publicnode.com');
      expect(mod.rpcSelection.provider).toBe('publicnode');
      expect(mod.rpcSelection.isPublicEndpoint).toBe(true);
    });

    it('should fall back to PublicNode devnet when in devnet mode with no keys', async () => {
      process.env.PARTITION_CHAINS = 'solana-devnet';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.url).toBe('https://solana-devnet.rpc.publicnode.com');
      expect(mod.rpcSelection.isPublicEndpoint).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Priority Ordering
  // ---------------------------------------------------------------------------

  describe('Priority ordering', () => {
    it('should prefer explicit URL over Helius when both set', async () => {
      process.env.SOLANA_RPC_URL = 'https://explicit.example.com';
      process.env.HELIUS_API_KEY = 'helius-key';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.provider).toBe('explicit');
    });

    it('should prefer Helius over Triton when both API keys set', async () => {
      process.env.HELIUS_API_KEY = 'helius-key';
      process.env.TRITON_API_KEY = 'triton-key';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.provider).toBe('helius');
    });

    it('should prefer explicit URL over Triton when both set', async () => {
      process.env.SOLANA_RPC_URL = 'https://explicit.example.com';
      process.env.TRITON_API_KEY = 'triton-key';
      const mod = await importIndexModule();
      cleanupFn = mod.cleanupProcessHandlers;
      expect(mod.rpcSelection.provider).toBe('explicit');
    });
  });
});

// =============================================================================
// Tests: isDevnetMode()
// =============================================================================

describe('isDevnetMode()', () => {
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  it('should return false when PARTITION_CHAINS is not set', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.isDevnetMode()).toBe(false);
  });

  it('should return false when PARTITION_CHAINS is solana (mainnet)', async () => {
    process.env.PARTITION_CHAINS = 'solana';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.isDevnetMode()).toBe(false);
  });

  it('should return true when PARTITION_CHAINS contains solana-devnet', async () => {
    process.env.PARTITION_CHAINS = 'solana-devnet';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.isDevnetMode()).toBe(true);
  });

  it('should return true when PARTITION_CHAINS has mixed chains including solana-devnet', async () => {
    process.env.PARTITION_CHAINS = 'solana,solana-devnet';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.isDevnetMode()).toBe(true);
  });

  it('should handle whitespace in chain names', async () => {
    process.env.PARTITION_CHAINS = ' solana-devnet , solana ';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.isDevnetMode()).toBe(true);
  });

  it('should be case-insensitive', async () => {
    process.env.PARTITION_CHAINS = 'Solana-Devnet';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.isDevnetMode()).toBe(true);
  });
});

// =============================================================================
// Tests: redactRpcUrl() (tested via arbitrageConfig.rpcUrl — not directly exported)
// =============================================================================

describe('redactRpcUrl() (via arbitrageConfig.rpcUrl)', () => {
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  it('should redact Helius API key from URL', async () => {
    process.env.HELIUS_API_KEY = 'my-secret-helius-key';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.rpcUrl).toContain('api-key=***REDACTED***');
    expect(mod.arbitrageConfig.rpcUrl).not.toContain('my-secret-helius-key');
  });

  it('should redact Triton API key from URL', async () => {
    process.env.TRITON_API_KEY = 'abcdef0123456789abcdef0123';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.rpcUrl).toContain('***REDACTED***');
    expect(mod.arbitrageConfig.rpcUrl).not.toContain('abcdef0123456789abcdef0123');
  });

  it('should pass through PublicNode URL unchanged', async () => {
    // No API keys → PublicNode fallback
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.rpcUrl).toBe('https://solana-mainnet.rpc.publicnode.com');
  });

  it('should pass through explicit URL with no sensitive patterns unchanged', async () => {
    process.env.SOLANA_RPC_URL = 'https://my-private-rpc.example.com/v1';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.rpcUrl).toBe('https://my-private-rpc.example.com/v1');
  });

  it('should redact api-key query param in explicit URL while preserving other params', async () => {
    process.env.SOLANA_RPC_URL = 'https://custom.rpc.com/?api-key=secret123&other=value';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.rpcUrl).toContain('api-key=***REDACTED***');
    expect(mod.arbitrageConfig.rpcUrl).toContain('other=value');
    expect(mod.arbitrageConfig.rpcUrl).not.toContain('secret123');
  });
});

// =============================================================================
// Tests: Environment Validation
// =============================================================================

describe('Environment Validation', () => {
  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('REDIS_URL validation', () => {
    it('should skip REDIS_URL validation when NODE_ENV is test', async () => {
      // NODE_ENV=test by default in setupTestEnv, no REDIS_URL set
      const mod = await importIndexModule();
      mod.cleanupProcessHandlers();
      const { exitWithConfigError } = jest.requireMock('@arbitrage/core');
      // exitWithConfigError should NOT have been called for REDIS_URL
      const redisUrlCalls = (exitWithConfigError as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('REDIS_URL')
      );
      expect(redisUrlCalls).toHaveLength(0);
    });

    it('should call exitWithConfigError when REDIS_URL missing in non-test env', async () => {
      setupTestEnv({ NODE_ENV: 'development' });
      clearSolanaEnvVars();
      delete process.env.REDIS_URL;

      await expect(importIndexModule()).rejects.toThrow(/REDIS_URL/);
    });

    it('should call exitWithConfigError for invalid REDIS_URL protocol', async () => {
      setupTestEnv({ NODE_ENV: 'development', REDIS_URL: 'http://localhost:6379' });
      clearSolanaEnvVars();

      await expect(importIndexModule()).rejects.toThrow(/invalid protocol|REDIS_URL/i);
    });

    it('should call exitWithConfigError for malformed REDIS_URL', async () => {
      setupTestEnv({ NODE_ENV: 'development', REDIS_URL: 'not-a-url' });
      clearSolanaEnvVars();

      await expect(importIndexModule()).rejects.toThrow(/REDIS_URL/);
    });

    it('should accept valid redis:// URL in non-test env', async () => {
      setupTestEnv({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' });
      clearSolanaEnvVars();
      process.env.HELIUS_API_KEY = 'test-key'; // Avoid production guard

      const mod = await importIndexModule();
      mod.cleanupProcessHandlers();
      // Should not throw — module loaded successfully
      expect(mod.P4_PARTITION_ID).toBe('solana-native');
    });

    it('should accept valid rediss:// URL in non-test env', async () => {
      setupTestEnv({ NODE_ENV: 'development', REDIS_URL: 'rediss://secure-host:6380' });
      clearSolanaEnvVars();
      process.env.HELIUS_API_KEY = 'test-key';

      const mod = await importIndexModule();
      mod.cleanupProcessHandlers();
      expect(mod.P4_PARTITION_ID).toBe('solana-native');
    });
  });

  describe('Production guard', () => {
    it('should call exitWithConfigError when public RPC used in production', async () => {
      setupTestEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
      });
      clearSolanaEnvVars();
      // No HELIUS_API_KEY or TRITON_API_KEY → PublicNode fallback → isPublicEndpoint=true

      await expect(importIndexModule()).rejects.toThrow(/Public Solana RPC/);
    });

    it('should not call exitWithConfigError when Helius key set in production', async () => {
      setupTestEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
      });
      clearSolanaEnvVars();
      process.env.HELIUS_API_KEY = 'production-helius-key';

      const mod = await importIndexModule();
      mod.cleanupProcessHandlers();
      expect(mod.rpcSelection.provider).toBe('helius');
    });
  });
});

// =============================================================================
// Tests: arbitrageConfig
// =============================================================================

describe('arbitrageConfig', () => {
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  it('should set default minProfitThreshold to 0.3', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.minProfitThreshold).toBe(0.3);
  });

  it('should parse MIN_PROFIT_THRESHOLD from env', async () => {
    process.env.MIN_PROFIT_THRESHOLD = '0.5';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.minProfitThreshold).toBe(0.5);
  });

  it('should preserve MIN_PROFIT_THRESHOLD=0 via nullish coalescing', async () => {
    process.env.MIN_PROFIT_THRESHOLD = '0';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    // '0' is truthy for ??, so parseFloat('0') === 0
    expect(mod.arbitrageConfig.minProfitThreshold).toBe(0);
  });

  it('should enable crossChainEnabled by default', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.crossChainEnabled).toBe(true);
  });

  it('should disable crossChainEnabled when set to false', async () => {
    process.env.CROSS_CHAIN_ENABLED = 'false';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.crossChainEnabled).toBe(false);
  });

  it('should enable triangularEnabled by default', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.triangularEnabled).toBe(true);
  });

  it('should disable triangularEnabled when set to false', async () => {
    process.env.TRIANGULAR_ENABLED = 'false';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.triangularEnabled).toBe(false);
  });

  it('should set default maxTriangularDepth to 3', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.maxTriangularDepth).toBe(3);
  });

  it('should parse MAX_TRIANGULAR_DEPTH from env', async () => {
    process.env.MAX_TRIANGULAR_DEPTH = '5';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.maxTriangularDepth).toBe(5);
  });

  it('should set default opportunityExpiryMs to 1000', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.opportunityExpiryMs).toBe(1000);
  });

  it('should parse OPPORTUNITY_EXPIRY_MS from env', async () => {
    process.env.OPPORTUNITY_EXPIRY_MS = '2000';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.opportunityExpiryMs).toBe(2000);
  });

  it('should set chainId to solana for mainnet mode', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.chainId).toBe('solana');
  });

  it('should set chainId to solana-devnet for devnet mode', async () => {
    process.env.PARTITION_CHAINS = 'solana-devnet';
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.arbitrageConfig.chainId).toBe('solana-devnet');
  });
});

// =============================================================================
// Tests: Event Handler Wiring
// =============================================================================

describe('Event Handler Wiring', () => {
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    process.env = originalEnv;
  });

  it('should register opportunity event handler on solanaArbitrageDetector', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    // The mock extends EventEmitter, so listenerCount should reflect registration
    expect(mockSolanaArbitrageInstance.listenerCount('opportunity')).toBeGreaterThan(0);
  });

  it('should register stopped event handler on detector', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;
    expect(mod.detector.listenerCount('stopped')).toBeGreaterThan(0);
  });

  it('should call publishOpportunity when opportunity event fires', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;

    // Re-setup publishOpportunity mock (resetMocks may have cleared it)
    mockSolanaArbitrageInstance.publishOpportunity.mockResolvedValue(undefined);

    const mockOpportunity = {
      id: 'opp-test-1',
      type: 'intra-solana',
      buyDex: 'raydium',
      sellDex: 'orca',
      profitPercentage: 1.5,
      confidence: 0.8,
    };

    // Emit opportunity on the mock (which is an EventEmitter)
    mockSolanaArbitrageInstance.emit('opportunity', mockOpportunity);

    // Allow async handler to execute
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockSolanaArbitrageInstance.publishOpportunity).toHaveBeenCalledWith(mockOpportunity);
  });

  it('should log opportunity details when opportunity event fires', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;

    mockSolanaArbitrageInstance.publishOpportunity.mockResolvedValue(undefined);

    const mockOpportunity = {
      id: 'opp-test-2',
      type: 'intra-solana',
      buyDex: 'raydium',
      sellDex: 'orca',
      profitPercentage: 1.5,
      confidence: 0.8,
    };

    mockSolanaArbitrageInstance.emit('opportunity', mockOpportunity);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Solana arbitrage opportunity detected',
      expect.objectContaining({
        id: 'opp-test-2',
        type: 'intra-solana',
      })
    );
  });

  it('should catch Redis publish errors without crashing', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;

    mockSolanaArbitrageInstance.publishOpportunity.mockRejectedValue(
      new Error('Redis connection lost')
    );

    const mockOpportunity = {
      id: 'opp-err-1',
      type: 'intra-solana',
      buyDex: 'raydium',
      sellDex: 'orca',
      profitPercentage: 1.0,
      confidence: 0.7,
    };

    mockSolanaArbitrageInstance.emit('opportunity', mockOpportunity);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to publish opportunity to Redis Streams',
      expect.objectContaining({
        opportunityId: 'opp-err-1',
        error: 'Redis connection lost',
      })
    );
  });

  it('should emit redis-publish-error event on publish failure', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;

    mockSolanaArbitrageInstance.publishOpportunity.mockRejectedValue(
      new Error('Redis timeout')
    );

    const emitSpy = jest.spyOn(mockSolanaArbitrageInstance, 'emit');

    const mockOpportunity = {
      id: 'opp-err-2',
      type: 'intra-solana',
      buyDex: 'raydium',
      sellDex: 'orca',
      profitPercentage: 0.8,
      confidence: 0.6,
    };

    mockSolanaArbitrageInstance.emit('opportunity', mockOpportunity);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(emitSpy).toHaveBeenCalledWith(
      'redis-publish-error',
      expect.objectContaining({
        opportunityId: 'opp-err-2',
        error: 'Redis timeout',
      })
    );

    emitSpy.mockRestore();
  });

  it('should handle non-Error objects thrown by publishOpportunity', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;

    mockSolanaArbitrageInstance.publishOpportunity.mockRejectedValue('network error');

    const mockOpportunity = {
      id: 'opp-err-3',
      type: 'intra-solana',
      buyDex: 'raydium',
      sellDex: 'orca',
      profitPercentage: 0.5,
      confidence: 0.5,
    };

    mockSolanaArbitrageInstance.emit('opportunity', mockOpportunity);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to publish opportunity to Redis Streams',
      expect.objectContaining({
        error: 'network error',
      })
    );
  });

  it('should stop solanaArbitrageDetector when detector emits stopped', async () => {
    const mod = await importIndexModule();
    cleanupFn = mod.cleanupProcessHandlers;

    mockSolanaArbitrageInstance.stop.mockResolvedValue(undefined);

    // Emit 'stopped' on the detector (MockUnifiedChainDetector extends EventEmitter)
    mod.detector.emit('stopped');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockSolanaArbitrageInstance.stop).toHaveBeenCalled();
  });
});

// =============================================================================
// Tests: Cleanup (cleanupAllHandlers / cleanupProcessHandlers)
// =============================================================================

describe('cleanupAllHandlers', () => {
  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearSolanaEnvVars();
    resetMockImplementations();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should call cleanupProcessHandlers without throwing', async () => {
    const mod = await importIndexModule();
    mockSolanaArbitrageInstance.stop.mockResolvedValue(undefined);
    expect(() => mod.cleanupProcessHandlers()).not.toThrow();
  });

  it('should be idempotent — safe to call multiple times', async () => {
    const mod = await importIndexModule();
    mockSolanaArbitrageInstance.stop.mockResolvedValue(undefined);
    expect(() => {
      mod.cleanupProcessHandlers();
      mod.cleanupProcessHandlers();
    }).not.toThrow();
  });

  it('should remove detector stopped listener during cleanup', async () => {
    const mod = await importIndexModule();
    mockSolanaArbitrageInstance.stop.mockResolvedValue(undefined);

    const listenersBefore = mod.detector.listenerCount('stopped');
    expect(listenersBefore).toBeGreaterThan(0);

    mod.cleanupProcessHandlers();

    const listenersAfter = mod.detector.listenerCount('stopped');
    expect(listenersAfter).toBeLessThan(listenersBefore);
  });

  it('should stop solanaArbitrageDetector during cleanup', async () => {
    const mod = await importIndexModule();
    mockSolanaArbitrageInstance.stop.mockResolvedValue(undefined);

    mod.cleanupProcessHandlers();

    expect(mockSolanaArbitrageInstance.stop).toHaveBeenCalled();
  });

  it('should handle solanaArbitrageDetector.stop() rejection gracefully', async () => {
    const mod = await importIndexModule();
    mockSolanaArbitrageInstance.stop.mockRejectedValue(new Error('stop failed'));

    // Should not throw even when stop() rejects
    expect(() => mod.cleanupProcessHandlers()).not.toThrow();
  });
});
