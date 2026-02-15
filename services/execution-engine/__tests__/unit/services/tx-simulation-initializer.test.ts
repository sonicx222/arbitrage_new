/**
 * Tests for TX Simulation Service Initializer
 *
 * Verifies initialization of Tenderly and Alchemy simulation providers
 * from environment configuration.
 */

import { initializeTxSimulationService, type SimulationProviderSource } from '../../../src/services/tx-simulation-initializer';

// Mock the simulation modules
jest.mock('../../../src/services/simulation/simulation.service', () => ({
  SimulationService: jest.fn().mockImplementation((opts) => ({
    _type: 'SimulationService',
    providers: opts.providers,
    config: opts.config,
  })),
}));

jest.mock('../../../src/services/simulation/tenderly-provider', () => ({
  createTenderlyProvider: jest.fn().mockImplementation((config) => ({
    _type: 'tenderly',
    chain: config.chain,
  })),
}));

jest.mock('../../../src/services/simulation/alchemy-provider', () => ({
  createAlchemyProvider: jest.fn().mockImplementation((config) => ({
    _type: 'alchemy',
    chain: config.chain,
  })),
}));

import { createTenderlyProvider } from '../../../src/services/simulation/tenderly-provider';
import { createAlchemyProvider } from '../../../src/services/simulation/alchemy-provider';
import { SimulationService } from '../../../src/services/simulation/simulation.service';

describe('initializeTxSimulationService', () => {
  let mockProviderSource: SimulationProviderSource;
  let mockLogger: any;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };

    // Clear simulation env vars
    delete process.env.TENDERLY_API_KEY;
    delete process.env.TENDERLY_ACCOUNT_SLUG;
    delete process.env.TENDERLY_PROJECT_SLUG;
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.SIMULATION_MIN_PROFIT;
    delete process.env.SIMULATION_TIME_CRITICAL_MS;

    mockProviderSource = {
      getProviders: jest.fn().mockReturnValue(new Map([
        ['ethereum', { _chain: 'ethereum' }],
        ['arbitrum', { _chain: 'arbitrum' }],
      ])),
      getProvider: jest.fn().mockImplementation((chain: string) => ({ _chain: chain })),
    };

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return null when no providers configured', () => {
    const result = initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Transaction simulation service not initialized - no providers configured',
      expect.objectContaining({ hint: expect.any(String) }),
    );
  });

  it('should initialize Tenderly providers when all env vars set', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';

    const result = initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(result).not.toBeNull();
    expect(createTenderlyProvider).toHaveBeenCalledTimes(2); // 2 chains
    expect(createTenderlyProvider).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tenderly',
      chain: 'ethereum',
      apiKey: 'test-key',
      accountSlug: 'test-account',
      projectSlug: 'test-project',
      enabled: true,
    }));
    expect(SimulationService).toHaveBeenCalledTimes(1);
  });

  it('should initialize Alchemy providers as fallback when Tenderly not configured', () => {
    process.env.ALCHEMY_API_KEY = 'alchemy-key';

    const result = initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(result).not.toBeNull();
    expect(createTenderlyProvider).not.toHaveBeenCalled();
    expect(createAlchemyProvider).toHaveBeenCalledTimes(2); // 2 chains
    expect(createAlchemyProvider).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alchemy',
      chain: 'ethereum',
      apiKey: 'alchemy-key',
      enabled: true,
    }));
  });

  it('should prefer Tenderly over Alchemy when both configured', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';
    process.env.ALCHEMY_API_KEY = 'alchemy-key';

    initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(createTenderlyProvider).toHaveBeenCalledTimes(2);
    // Alchemy skipped because Tenderly providers exist (providers.length > 0)
    expect(createAlchemyProvider).not.toHaveBeenCalled();
  });

  it('should use default config values when env vars not set', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';

    initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(SimulationService).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        minProfitForSimulation: 50,
        timeCriticalThresholdMs: 2000,
        bypassForTimeCritical: true,
        useFallback: true,
      }),
    }));
  });

  it('should use custom config values from env vars', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';
    process.env.SIMULATION_MIN_PROFIT = '100';
    process.env.SIMULATION_TIME_CRITICAL_MS = '3000';

    initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(SimulationService).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        minProfitForSimulation: 100,
        timeCriticalThresholdMs: 3000,
      }),
    }));
  });

  it('should handle Tenderly initialization error gracefully', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';

    (createTenderlyProvider as jest.Mock).mockImplementation(() => {
      throw new Error('Tenderly init failed');
    });

    const result = initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(result).toBeNull(); // Falls through to no providers
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to initialize Tenderly provider',
      expect.objectContaining({ error: expect.stringContaining('Tenderly init failed') }),
    );
  });

  it('should skip chains where getProvider returns undefined', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';

    (mockProviderSource.getProvider as jest.Mock).mockImplementation((chain: string) => {
      if (chain === 'ethereum') return { _chain: 'ethereum' };
      return undefined; // arbitrum has no provider
    });

    initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(createTenderlyProvider).toHaveBeenCalledTimes(1); // Only ethereum
  });

  it('should return null when provider source has no chains', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';

    (mockProviderSource.getProviders as jest.Mock).mockReturnValue(new Map());

    const result = initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(result).toBeNull();
  });

  it('should log provider count and chain list on successful initialization', () => {
    process.env.TENDERLY_API_KEY = 'test-key';
    process.env.TENDERLY_ACCOUNT_SLUG = 'test-account';
    process.env.TENDERLY_PROJECT_SLUG = 'test-project';

    initializeTxSimulationService(mockProviderSource, mockLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Transaction simulation service initialized',
      expect.objectContaining({
        providerCount: 2,
        chains: ['ethereum', 'arbitrum'],
      }),
    );
  });
});
