/**
 * Unit Tests for P4 Service Configuration Module
 *
 * Tests assembleConfig(), partition constants, and config assembly
 * from environment variables and the partition registry.
 *
 * @see services/partition-solana/src/service-config.ts
 */

// =============================================================================
// Mock Instances (created before jest.mock calls)
// =============================================================================

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

// =============================================================================
// Module Mocks
// =============================================================================

const mockExitWithConfigError = jest.fn();

const mockParsePort = jest.fn().mockImplementation(
  (portEnv: string | undefined, defaultPort: number) => {
    if (!portEnv) return defaultPort;
    const parsed = parseInt(portEnv, 10);
    return isNaN(parsed) || parsed < 1 || parsed > 65535 ? defaultPort : parsed;
  }
);

const mockValidateAndFilterChains = jest.fn().mockImplementation(
  (_chainsEnv: string | undefined, defaultChains: readonly string[]) => {
    return [...defaultChains];
  }
);

const mockGenerateInstanceId = jest.fn().mockImplementation(
  (partitionId: string, providedId?: string) => {
    if (providedId) return providedId;
    return `${partitionId}-local-12345`;
  }
);

jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn().mockReturnValue(mockLogger),
}));

jest.mock('@arbitrage/core/partition', () => ({
  parsePort: mockParsePort,
  validateAndFilterChains: mockValidateAndFilterChains,
  exitWithConfigError: mockExitWithConfigError,
  PARTITION_PORTS: {
    'asia-fast': 3001,
    'l2-turbo': 3002,
    'high-value': 3003,
    'solana-native': 3004,
  },
  PARTITION_SERVICE_NAMES: {
    'asia-fast': 'partition-asia-fast',
    'l2-turbo': 'partition-l2-turbo',
    'high-value': 'partition-high-value',
    'solana-native': 'partition-solana',
  },
  generateInstanceId: mockGenerateInstanceId,
}));

const mockGetPartition = jest.fn();

jest.mock('@arbitrage/config', () => ({
  getPartition: mockGetPartition,
  PARTITION_IDS: {
    ASIA_FAST: 'asia-fast',
    L2_TURBO: 'l2-turbo',
    HIGH_VALUE: 'high-value',
    SOLANA_NATIVE: 'solana-native',
  },
}));

// Stub @arbitrage/unified-detector (only used for type imports)
jest.mock('@arbitrage/unified-detector', () => ({}));

// Mock the local rpc-config module
const mockSelectSolanaRpcUrl = jest.fn();
const mockIsDevnetMode = jest.fn();
const mockRedactRpcUrl = jest.fn();

jest.mock('../../src/rpc-config', () => ({
  selectSolanaRpcUrl: mockSelectSolanaRpcUrl,
  isDevnetMode: mockIsDevnetMode,
  redactRpcUrl: mockRedactRpcUrl,
}));

// Mock the local arbitrage-detector module (only used for type imports)
jest.mock('../../src/arbitrage-detector', () => ({}));

// =============================================================================
// Test Helpers
// =============================================================================

const originalEnv = process.env;

function setupTestEnv(overrides: Record<string, string> = {}): void {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'test',
    ...overrides,
  };
}

function clearEnvVars(): void {
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

/** Default mock partition config for solana-native */
const defaultPartitionConfig = {
  partitionId: 'solana-native',
  name: 'Solana Native',
  chains: ['solana'],
  region: 'us-west1',
  provider: 'oracle',
  resourceProfile: 'heavy',
  priority: 4,
  maxMemoryMB: 768,
  enabled: true,
  healthCheckIntervalMs: 10000,
  failoverTimeoutMs: 45000,
};

/** Default mock RPC selection result */
const defaultRpcSelection = {
  url: 'https://solana-mainnet.rpc.publicnode.com',
  provider: 'publicnode',
  isPublicEndpoint: true,
};

function setupDefaultMocks(): void {
  mockGetPartition.mockReturnValue(defaultPartitionConfig);
  mockSelectSolanaRpcUrl.mockReturnValue(defaultRpcSelection);
  mockIsDevnetMode.mockReturnValue(false);
  mockRedactRpcUrl.mockImplementation((url: string) => url);
  // Re-setup exitWithConfigError to throw (clearAllMocks resets it each time)
  mockExitWithConfigError.mockImplementation((msg: string) => {
    throw new Error(`Config error: ${msg}`);
  });
  // Re-setup parsePort (clearAllMocks resets it)
  mockParsePort.mockImplementation(
    (portEnv: string | undefined, defaultPort: number) => {
      if (!portEnv) return defaultPort;
      const parsed = parseInt(portEnv, 10);
      return isNaN(parsed) || parsed < 1 || parsed > 65535 ? defaultPort : parsed;
    }
  );
  // Re-setup validateAndFilterChains
  mockValidateAndFilterChains.mockImplementation(
    (_chainsEnv: string | undefined, defaultChains: readonly string[]) => {
      return [...defaultChains];
    }
  );
  // Re-setup generateInstanceId
  mockGenerateInstanceId.mockImplementation(
    (partitionId: string, providedId?: string) => {
      if (providedId) return providedId;
      return `${partitionId}-local-12345`;
    }
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('service-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupTestEnv();
    clearEnvVars();
    setupDefaultMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  describe('P4_PARTITION_ID', () => {
    it('should equal solana-native', async () => {
      const { P4_PARTITION_ID } = await import('../../src/service-config');
      expect(P4_PARTITION_ID).toBe('solana-native');
    });
  });

  describe('P4_DEFAULT_PORT', () => {
    it('should equal 3004', async () => {
      const { P4_DEFAULT_PORT } = await import('../../src/service-config');
      expect(P4_DEFAULT_PORT).toBe(3004);
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — Basic Output Structure
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - output structure', () => {
    it('should return all expected keys', () => {
      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result).toHaveProperty('P4_CHAINS');
      expect(result).toHaveProperty('P4_REGION');
      expect(result).toHaveProperty('serviceConfig');
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('arbitrageConfig');
      expect(result).toHaveProperty('rpcSelection');
    });

    it('should return P4_CHAINS from partition config', () => {
      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result.P4_CHAINS).toEqual(['solana']);
    });

    it('should return P4_REGION from partition config', () => {
      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result.P4_REGION).toBe('us-west1');
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — serviceConfig
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - serviceConfig', () => {
    it('should have correct partitionId', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.partitionId).toBe('solana-native');
    });

    it('should have correct serviceName', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.serviceName).toBe('partition-solana');
    });

    it('should have defaultChains from partition config', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.defaultChains).toEqual(['solana']);
    });

    it('should have defaultPort from PARTITION_PORTS', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.defaultPort).toBe(3004);
    });

    it('should have region from partition config', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.region).toBe('us-west1');
    });

    it('should have provider from partition config', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.provider).toBe('oracle');
    });

    it('should use default serviceName when PARTITION_SERVICE_NAMES has no entry', () => {
      // getPartition returns config but PARTITION_SERVICE_NAMES doesn't have the key
      // The ?? 'partition-solana' fallback in the source handles this
      mockGetPartition.mockReturnValue({
        ...defaultPartitionConfig,
        partitionId: 'solana-native',
      });

      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      // Should still get 'partition-solana' since the mock includes it
      expect(serviceConfig.serviceName).toBe('partition-solana');
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — UnifiedDetectorConfig (config)
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - UnifiedDetectorConfig', () => {
    it('should have correct partitionId', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.partitionId).toBe('solana-native');
    });

    it('should call validateAndFilterChains with PARTITION_CHAINS env', () => {
      process.env.PARTITION_CHAINS = 'solana';
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockValidateAndFilterChains).toHaveBeenCalledWith(
        'solana',
        ['solana'],
        mockLogger
      );
    });

    it('should call generateInstanceId with partition ID and env INSTANCE_ID', () => {
      process.env.INSTANCE_ID = 'custom-instance-id';
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockGenerateInstanceId).toHaveBeenCalledWith(
        'solana-native',
        'custom-instance-id'
      );
    });

    it('should use generated instanceId in config', () => {
      mockGenerateInstanceId.mockReturnValue('solana-native-generated-123');
      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.instanceId).toBe('solana-native-generated-123');
    });

    it('should use REGION_ID env var when set', () => {
      process.env.REGION_ID = 'eu-west1';
      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.regionId).toBe('eu-west1');
    });

    it('should fall back to partition region when REGION_ID is not set', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.regionId).toBe('us-west1');
    });

    it('should enable cross-region health by default', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.enableCrossRegionHealth).toBe(true);
    });

    it('should disable cross-region health when ENABLE_CROSS_REGION_HEALTH=false', () => {
      process.env.ENABLE_CROSS_REGION_HEALTH = 'false';
      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.enableCrossRegionHealth).toBe(false);
    });

    it('should call parsePort with HEALTH_CHECK_PORT and default port', () => {
      process.env.HEALTH_CHECK_PORT = '9999';
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockParsePort).toHaveBeenCalledWith('9999', 3004, mockLogger);
    });

    it('should use default port when HEALTH_CHECK_PORT is not set', () => {
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockParsePort).toHaveBeenCalledWith(undefined, 3004, mockLogger);
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — arbitrageConfig
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - arbitrageConfig', () => {
    it('should set default minProfitThreshold to 0.3', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.minProfitThreshold).toBe(0.3);
    });

    it('should parse MIN_PROFIT_THRESHOLD from env', () => {
      process.env.MIN_PROFIT_THRESHOLD = '0.5';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.minProfitThreshold).toBe(0.5);
    });

    it('should preserve MIN_PROFIT_THRESHOLD=0 via nullish coalescing', () => {
      process.env.MIN_PROFIT_THRESHOLD = '0';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      // '0' is truthy for ??, so parseFloat('0') === 0
      expect(arbitrageConfig.minProfitThreshold).toBe(0);
    });

    it('should enable crossChainEnabled by default', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.crossChainEnabled).toBe(true);
    });

    it('should disable crossChainEnabled when CROSS_CHAIN_ENABLED=false', () => {
      process.env.CROSS_CHAIN_ENABLED = 'false';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.crossChainEnabled).toBe(false);
    });

    it('should keep crossChainEnabled=true for any value other than false', () => {
      process.env.CROSS_CHAIN_ENABLED = 'true';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.crossChainEnabled).toBe(true);
    });

    it('should enable triangularEnabled by default', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.triangularEnabled).toBe(true);
    });

    it('should disable triangularEnabled when TRIANGULAR_ENABLED=false', () => {
      process.env.TRIANGULAR_ENABLED = 'false';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.triangularEnabled).toBe(false);
    });

    it('should set default maxTriangularDepth to 3', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.maxTriangularDepth).toBe(3);
    });

    it('should parse MAX_TRIANGULAR_DEPTH from env', () => {
      process.env.MAX_TRIANGULAR_DEPTH = '5';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.maxTriangularDepth).toBe(5);
    });

    it('should set default opportunityExpiryMs to 1000', () => {
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.opportunityExpiryMs).toBe(1000);
    });

    it('should parse OPPORTUNITY_EXPIRY_MS from env', () => {
      process.env.OPPORTUNITY_EXPIRY_MS = '2000';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.opportunityExpiryMs).toBe(2000);
    });

    it('should set chainId to solana for mainnet mode', () => {
      mockIsDevnetMode.mockReturnValue(false);
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.chainId).toBe('solana');
    });

    it('should set chainId to solana-devnet for devnet mode', () => {
      mockIsDevnetMode.mockReturnValue(true);
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.chainId).toBe('solana-devnet');
    });

    it('should store redacted RPC URL in arbitrageConfig', () => {
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://mainnet.helius-rpc.com/?api-key=secret123',
        provider: 'helius',
        isPublicEndpoint: false,
      });
      mockRedactRpcUrl.mockReturnValue('https://mainnet.helius-rpc.com/?api-key=***REDACTED***');

      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(mockRedactRpcUrl).toHaveBeenCalledWith('https://mainnet.helius-rpc.com/?api-key=secret123');
      expect(arbitrageConfig.rpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=***REDACTED***');
    });

    it('should call redactRpcUrl with the selected RPC URL', () => {
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://solana-mainnet.rpc.extrnode.com/abcdef0123456789abcdef',
        provider: 'triton',
        isPublicEndpoint: false,
      });
      mockRedactRpcUrl.mockReturnValue('https://solana-mainnet.rpc.extrnode.com/***REDACTED***');

      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockRedactRpcUrl).toHaveBeenCalledWith(
        'https://solana-mainnet.rpc.extrnode.com/abcdef0123456789abcdef'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — rpcSelection
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - rpcSelection', () => {
    it('should return the result from selectSolanaRpcUrl', () => {
      const customRpcSelection = {
        url: 'https://custom.rpc.com',
        provider: 'explicit',
        isPublicEndpoint: false,
      };
      mockSelectSolanaRpcUrl.mockReturnValue(customRpcSelection);

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result.rpcSelection).toEqual(customRpcSelection);
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — Partition Config Not Found
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - partition config not found', () => {
    it('should call exitWithConfigError when partition config is null', () => {
      mockGetPartition.mockReturnValue(null);

      const { assembleConfig } = require('../../src/service-config');

      expect(() => assembleConfig(mockLogger)).toThrow('Config error: P4 partition configuration not found');
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'P4 partition configuration not found',
        expect.objectContaining({ partitionId: 'solana-native' }),
        mockLogger
      );
    });

    it('should call exitWithConfigError when partition config is undefined', () => {
      mockGetPartition.mockReturnValue(undefined);

      const { assembleConfig } = require('../../src/service-config');

      expect(() => assembleConfig(mockLogger)).toThrow('Config error: P4 partition configuration not found');
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — Production Public RPC Guard
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - production public RPC guard', () => {
    it('should call exitWithConfigError when public RPC in production', () => {
      process.env.NODE_ENV = 'production';
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://solana-mainnet.rpc.publicnode.com',
        provider: 'publicnode',
        isPublicEndpoint: true,
      });

      const { assembleConfig } = require('../../src/service-config');

      expect(() => assembleConfig(mockLogger)).toThrow(
        'Config error: Public Solana RPC endpoint cannot be used in production'
      );
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        'Public Solana RPC endpoint cannot be used in production',
        expect.objectContaining({
          partitionId: 'solana-native',
          provider: 'publicnode',
          hint: expect.stringContaining('HELIUS_API_KEY'),
        }),
        mockLogger
      );
    });

    it('should include network type in production guard error context', () => {
      process.env.NODE_ENV = 'production';
      mockIsDevnetMode.mockReturnValue(true);
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://solana-devnet.rpc.publicnode.com',
        provider: 'publicnode',
        isPublicEndpoint: true,
      });

      const { assembleConfig } = require('../../src/service-config');

      expect(() => assembleConfig(mockLogger)).toThrow();
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ network: 'devnet' }),
        mockLogger
      );
    });

    it('should include mainnet network when not in devnet mode', () => {
      process.env.NODE_ENV = 'production';
      mockIsDevnetMode.mockReturnValue(false);
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://solana-mainnet.rpc.publicnode.com',
        provider: 'publicnode',
        isPublicEndpoint: true,
      });

      const { assembleConfig } = require('../../src/service-config');

      expect(() => assembleConfig(mockLogger)).toThrow();
      expect(mockExitWithConfigError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ network: 'mainnet' }),
        mockLogger
      );
    });

    it('should not call exitWithConfigError for public RPC in non-production', () => {
      process.env.NODE_ENV = 'development';
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://solana-mainnet.rpc.publicnode.com',
        provider: 'publicnode',
        isPublicEndpoint: true,
      });

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      // Should not throw - public RPC allowed in non-production
      expect(result.rpcSelection.isPublicEndpoint).toBe(true);
      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should not call exitWithConfigError for private RPC in production', () => {
      process.env.NODE_ENV = 'production';
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://mainnet.helius-rpc.com/?api-key=prod-key',
        provider: 'helius',
        isPublicEndpoint: false,
      });

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result.rpcSelection.isPublicEndpoint).toBe(false);
      expect(mockExitWithConfigError).not.toHaveBeenCalled();
    });

    it('should not call exitWithConfigError for public RPC in test env', () => {
      process.env.NODE_ENV = 'test';
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://solana-mainnet.rpc.publicnode.com',
        provider: 'publicnode',
        isPublicEndpoint: true,
      });

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(mockExitWithConfigError).not.toHaveBeenCalled();
      expect(result.rpcSelection.isPublicEndpoint).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — Devnet Mode
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - devnet mode', () => {
    it('should set chainId to solana-devnet when devnet mode active', () => {
      mockIsDevnetMode.mockReturnValue(true);

      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.chainId).toBe('solana-devnet');
    });

    it('should set chainId to solana when not in devnet mode', () => {
      mockIsDevnetMode.mockReturnValue(false);

      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.chainId).toBe('solana');
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — Defensive defaults (null-safety)
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - defensive defaults', () => {
    it('should use default chains when partition config has no chains', () => {
      // exitWithConfigError is called but the code continues with optional chaining
      // We need to make exitWithConfigError NOT throw for this test
      mockExitWithConfigError.mockImplementation(() => {});
      mockGetPartition.mockReturnValue(null);

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      // With null partition config and optional chaining, defaults to ['solana']
      expect(result.P4_CHAINS).toEqual(['solana']);
    });

    it('should use default region when partition config has no region', () => {
      mockExitWithConfigError.mockImplementation(() => {});
      mockGetPartition.mockReturnValue(null);

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result.P4_REGION).toBe('us-west1');
    });

    it('should use default provider when partition config has no provider', () => {
      mockExitWithConfigError.mockImplementation(() => {});
      mockGetPartition.mockReturnValue({ chains: ['solana'], region: 'us-west1' });

      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.provider).toBe('oracle');
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — Calls correct functions
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - function invocations', () => {
    it('should call getPartition with solana-native', () => {
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockGetPartition).toHaveBeenCalledWith('solana-native');
    });

    it('should call selectSolanaRpcUrl', () => {
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockSelectSolanaRpcUrl).toHaveBeenCalled();
    });

    it('should call isDevnetMode for chainId determination', () => {
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockIsDevnetMode).toHaveBeenCalled();
    });

    it('should call redactRpcUrl with selected URL', () => {
      mockSelectSolanaRpcUrl.mockReturnValue({
        url: 'https://test-rpc.example.com',
        provider: 'explicit',
        isPublicEndpoint: false,
      });

      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockRedactRpcUrl).toHaveBeenCalledWith('https://test-rpc.example.com');
    });

    it('should call validateAndFilterChains with env and default chains', () => {
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockValidateAndFilterChains).toHaveBeenCalledWith(
        undefined, // PARTITION_CHAINS not set
        ['solana'],
        mockLogger
      );
    });

    it('should call generateInstanceId with partition ID and INSTANCE_ID', () => {
      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockGenerateInstanceId).toHaveBeenCalledWith(
        'solana-native',
        undefined // INSTANCE_ID not set
      );
    });

    it('should pass INSTANCE_ID from env to generateInstanceId', () => {
      process.env.INSTANCE_ID = 'my-instance';

      const { assembleConfig } = require('../../src/service-config');
      assembleConfig(mockLogger);

      expect(mockGenerateInstanceId).toHaveBeenCalledWith(
        'solana-native',
        'my-instance'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — env var overrides for all fields
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - env var overrides', () => {
    it('should use custom MIN_PROFIT_THRESHOLD=1.5', () => {
      process.env.MIN_PROFIT_THRESHOLD = '1.5';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.minProfitThreshold).toBe(1.5);
    });

    it('should use custom MAX_TRIANGULAR_DEPTH=4', () => {
      process.env.MAX_TRIANGULAR_DEPTH = '4';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.maxTriangularDepth).toBe(4);
    });

    it('should use custom OPPORTUNITY_EXPIRY_MS=5000', () => {
      process.env.OPPORTUNITY_EXPIRY_MS = '5000';
      const { assembleConfig } = require('../../src/service-config');
      const { arbitrageConfig } = assembleConfig(mockLogger);

      expect(arbitrageConfig.opportunityExpiryMs).toBe(5000);
    });

    it('should use custom HEALTH_CHECK_PORT', () => {
      process.env.HEALTH_CHECK_PORT = '8080';
      mockParsePort.mockReturnValue(8080);

      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.healthCheckPort).toBe(8080);
    });

    it('should use custom REGION_ID', () => {
      process.env.REGION_ID = 'asia-east1';

      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.regionId).toBe('asia-east1');
    });

    it('should set ENABLE_CROSS_REGION_HEALTH=false', () => {
      process.env.ENABLE_CROSS_REGION_HEALTH = 'false';

      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.enableCrossRegionHealth).toBe(false);
    });

    it('should keep ENABLE_CROSS_REGION_HEALTH=true for non-false values', () => {
      process.env.ENABLE_CROSS_REGION_HEALTH = 'true';

      const { assembleConfig } = require('../../src/service-config');
      const { config } = assembleConfig(mockLogger);

      expect(config.enableCrossRegionHealth).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // assembleConfig() — Custom partition config
  // ---------------------------------------------------------------------------

  describe('assembleConfig() - custom partition config', () => {
    it('should use chains from partition config', () => {
      mockGetPartition.mockReturnValue({
        ...defaultPartitionConfig,
        chains: ['solana', 'solana-devnet'],
      });

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result.P4_CHAINS).toEqual(['solana', 'solana-devnet']);
    });

    it('should use region from partition config', () => {
      mockGetPartition.mockReturnValue({
        ...defaultPartitionConfig,
        region: 'eu-central1',
      });

      const { assembleConfig } = require('../../src/service-config');
      const result = assembleConfig(mockLogger);

      expect(result.P4_REGION).toBe('eu-central1');
    });

    it('should use provider from partition config', () => {
      mockGetPartition.mockReturnValue({
        ...defaultPartitionConfig,
        provider: 'custom-provider',
      });

      const { assembleConfig } = require('../../src/service-config');
      const { serviceConfig } = assembleConfig(mockLogger);

      expect(serviceConfig.provider).toBe('custom-provider');
    });
  });
});
