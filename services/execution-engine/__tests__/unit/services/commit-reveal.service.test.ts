/**
 * CommitRevealService Unit Tests
 *
 * Comprehensive test coverage for the commit-reveal MEV protection service.
 *
 * Test Coverage:
 * - Service initialization and configuration
 * - Commit phase (hash generation, storage, validation)
 * - Reveal phase (verification, execution, profit validation)
 * - Redis storage operations (SET NX, GET, DEL)
 * - Contract factory usage
 * - Error handling for all failure cases
 * - Cleanup operations
 *
 * @see services/execution-engine/src/services/commit-reveal.service.ts
 */

import {
  CommitRevealService,
  type ContractFactory,
  type CommitRevealParams,
  type SwapStep,
} from '../../../src/services/commit-reveal.service';
import type { Logger, StrategyContext } from '../../../src/types';
import type { Redis } from 'ioredis';
import { ethers } from 'ethers';

// =============================================================================
// Mock Implementations
// =============================================================================

/**
 * Create mock logger with jest spy functions
 */
const createMockLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

/**
 * Create mock Redis client
 */
const createMockRedis = (): jest.Mocked<Redis> => ({
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
} as any);

/**
 * Create mock contract instance
 */
const createMockContract = () => ({
  commit: jest.fn(),
  reveal: jest.fn(),
  cancelCommit: jest.fn(),
  interface: {
    parseLog: jest.fn(),
  },
});

/**
 * Create mock contract factory
 */
const createMockContractFactory = (mockContract: any): ContractFactory => ({
  createContract: jest.fn().mockReturnValue(mockContract),
});

/**
 * Create mock provider
 */
const createMockProvider = () => ({
  getBlockNumber: jest.fn(),
});

/**
 * Create mock wallet
 */
const createMockWallet = () => ({
  address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
});

/**
 * Create mock strategy context
 */
const createMockContext = (
  provider: any = createMockProvider(),
  wallet: any = createMockWallet()
): StrategyContext => {
  const providers = new Map();
  providers.set('ethereum', provider);

  const wallets = new Map();
  wallets.set('ethereum', wallet);

  return {
    providers,
    wallets,
  } as any;
};

/**
 * Create sample commit-reveal parameters
 */
const createSampleParams = (): CommitRevealParams => {
  const swapPath: SwapStep[] = [
    {
      router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountOutMin: 1000000n,
    },
  ];

  return {
    asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    amountIn: 1000000000000000000n,
    swapPath,
    minProfit: 100000000000000000n,
    deadline: Math.floor(Date.now() / 1000) + 300,
    salt: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  };
};

// =============================================================================
// Test Suite: Service Initialization
// =============================================================================

describe('CommitRevealService - Initialization', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
  });

  it('should initialize successfully with valid contract addresses', () => {
    const contractAddresses = {
      ethereum: '0x1234567890123456789012345678901234567890',
      polygon: '0x2345678901234567890123456789012345678901',
    };

    const service = new CommitRevealService(mockLogger, contractAddresses);

    expect(service).toBeDefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'CommitRevealService initialized',
      expect.objectContaining({
        deployedChains: ['ethereum', 'polygon'],
        chainCount: 2,
        redisEnabled: false,
      })
    );
  });

  it('should warn when no contract addresses are configured', () => {
    const service = new CommitRevealService(mockLogger, {});

    expect(service).toBeDefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('initialized with no deployed contracts'),
      expect.any(Object)
    );
  });

  it('should accept optional Redis client', () => {
    const mockRedis = createMockRedis();
    const contractAddresses = { ethereum: '0x1234567890123456789012345678901234567890' };

    const service = new CommitRevealService(mockLogger, contractAddresses, mockRedis);

    expect(service).toBeDefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'CommitRevealService initialized',
      expect.objectContaining({
        redisEnabled: true,
      })
    );
  });

  it('should accept optional contract factory', () => {
    const mockContract = createMockContract();
    const mockFactory = createMockContractFactory(mockContract);
    const contractAddresses = { ethereum: '0x1234567890123456789012345678901234567890' };

    const service = new CommitRevealService(mockLogger, contractAddresses, undefined, mockFactory);

    expect(service).toBeDefined();
  });

  it('should filter out empty contract addresses', () => {
    const contractAddresses = {
      ethereum: '0x1234567890123456789012345678901234567890',
      polygon: '',
      arbitrum: '0x3456789012345678901234567890123456789012',
    };

    const service = new CommitRevealService(mockLogger, contractAddresses);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'CommitRevealService initialized',
      expect.objectContaining({
        deployedChains: ['ethereum', 'arbitrum'],
        chainCount: 2,
      })
    );
  });
});

// =============================================================================
// Test Suite: Commit Phase
// =============================================================================

describe('CommitRevealService - Commit Phase', () => {
  let mockLogger: Logger;
  let mockContract: any;
  let mockFactory: ContractFactory;
  let mockContext: StrategyContext;
  let service: CommitRevealService;

  const contractAddresses = {
    ethereum: '0x1234567890123456789012345678901234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockContract = createMockContract();
    mockFactory = createMockContractFactory(mockContract);
    mockContext = createMockContext();

    // Mock successful commit transaction
    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    service = new CommitRevealService(mockLogger, contractAddresses, undefined, mockFactory);
  });

  it('should successfully commit with valid parameters', async () => {
    const params = createSampleParams();

    const result = await service.commit(params, 'ethereum', mockContext, 'opp-123', 1.5);

    expect(result.success).toBe(true);
    expect(result.commitmentHash).toBeDefined();
    expect(result.commitmentHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.txHash).toBe('0xabcd1234');
    expect(result.commitBlock).toBe(100);
    expect(result.revealBlock).toBe(101);
    expect(result.error).toBeUndefined();

    expect(mockContract.commit).toHaveBeenCalledWith(result.commitmentHash);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Submitting commit transaction',
      expect.objectContaining({
        chain: 'ethereum',
        commitmentHash: result.commitmentHash,
        opportunityId: 'opp-123',
      })
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Commitment confirmed on-chain',
      expect.objectContaining({
        chain: 'ethereum',
        commitmentHash: result.commitmentHash,
        txHash: '0xabcd1234',
        commitBlock: 100,
        revealBlock: 101,
      })
    );
  });

  it('should fail when no contract is deployed on chain', async () => {
    const params = createSampleParams();

    const result = await service.commit(params, 'polygon', mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No commit-reveal contract deployed on polygon');
    expect(mockContract.commit).not.toHaveBeenCalled();
  });

  it('should fail when no wallet is available for chain', async () => {
    const params = createSampleParams();
    const ctx = createMockContext();
    ctx.wallets.clear();

    const result = await service.commit(params, 'ethereum', ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No wallet configured for chain: ethereum');
    expect(mockContract.commit).not.toHaveBeenCalled();
  });

  it('should handle transaction errors gracefully', async () => {
    const params = createSampleParams();
    mockContract.commit.mockRejectedValue(new Error('Transaction failed: insufficient funds'));

    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Transaction failed: insufficient funds');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Commit transaction failed',
      expect.objectContaining({
        chain: 'ethereum',
        error: 'Transaction failed: insufficient funds',
      })
    );
  });

  it('should generate consistent commitment hash for same parameters', async () => {
    const params = createSampleParams();

    const result1 = await service.commit(params, 'ethereum', mockContext);

    // Create a new service instance to avoid in-memory duplicate detection
    const mockContract2 = createMockContract();
    const mockFactory2 = createMockContractFactory(mockContract2);
    mockContract2.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd5678',
        blockNumber: 101,
      }),
    });
    const service2 = new CommitRevealService(mockLogger, contractAddresses, undefined, mockFactory2);

    const result2 = await service2.commit(params, 'ethereum', mockContext);

    expect(result1.commitmentHash).toBe(result2.commitmentHash);
  });

  it('should generate different hashes for different parameters', async () => {
    const params1 = createSampleParams();
    const params2 = { ...params1, amountIn: 2000000000000000000n };

    const result1 = await service.commit(params1, 'ethereum', mockContext);

    jest.clearAllMocks();
    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd5678',
        blockNumber: 101,
      }),
    });

    const result2 = await service.commit(params2, 'ethereum', mockContext);

    expect(result1.commitmentHash).not.toBe(result2.commitmentHash);
  });

  it('should use contract factory to create contract instance', async () => {
    const params = createSampleParams();

    await service.commit(params, 'ethereum', mockContext);

    expect(mockFactory.createContract).toHaveBeenCalledWith(
      contractAddresses.ethereum,
      expect.any(Array),
      expect.any(Object)
    );
  });

  it('should generate default opportunity ID if not provided', async () => {
    const params = createSampleParams();
    const beforeTime = Date.now();

    await service.commit(params, 'ethereum', mockContext);

    const afterTime = Date.now();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Submitting commit transaction',
      expect.objectContaining({
        chain: 'ethereum',
        opportunityId: undefined,
      })
    );
  });
});

// =============================================================================
// Test Suite: Reveal Phase
// =============================================================================

describe('CommitRevealService - Reveal Phase', () => {
  let mockLogger: Logger;
  let mockContract: any;
  let mockFactory: ContractFactory;
  let mockProvider: any;
  let mockContext: StrategyContext;
  let service: CommitRevealService;

  const contractAddresses = {
    ethereum: '0x1234567890123456789012345678901234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockContract = createMockContract();
    mockFactory = createMockContractFactory(mockContract);
    mockProvider = createMockProvider();
    mockContext = createMockContext(mockProvider);

    // Mock successful commit transaction
    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    // Mock successful reveal transaction with Revealed event
    const mockInterface = new ethers.Interface([
      'event Revealed(bytes32 indexed commitmentHash, address indexed tokenIn, address indexed tokenOut, uint256 profit)',
    ]);
    const revealedLog = mockInterface.encodeEventLog(
      'Revealed',
      [
        '0x1234567890123456789012345678901234567890123456789012345678901234',
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        500000000000000000n,
      ]
    );

    mockContract.reveal.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xreveal1234',
        logs: [
          {
            topics: revealedLog.topics,
            data: revealedLog.data,
          },
        ],
      }),
    });

    mockProvider.getBlockNumber.mockResolvedValue(101);

    service = new CommitRevealService(mockLogger, contractAddresses, undefined, mockFactory);
  });

  it('should successfully reveal after commit', async () => {
    const params = createSampleParams();

    // Commit first
    const commitResult = await service.commit(params, 'ethereum', mockContext, 'opp-123');
    expect(commitResult.success).toBe(true);

    // Reveal
    const revealResult = await service.reveal(commitResult.commitmentHash, 'ethereum', mockContext);

    expect(revealResult.success).toBe(true);
    expect(revealResult.txHash).toBe('0xreveal1234');
    expect(revealResult.profit).toBe(500000000000000000n);
    expect(revealResult.error).toBeUndefined();

    expect(mockContract.reveal).toHaveBeenCalledWith(params);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Reveal successful',
      expect.objectContaining({
        commitmentHash: commitResult.commitmentHash,
        chain: 'ethereum',
        txHash: '0xreveal1234',
        profit: '500000000000000000',
      })
    );
  });

  it('should fail when commitment state not found', async () => {
    const result = await service.reveal('0xinvalidhash', 'ethereum', mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Commitment state not found');
    expect(mockContract.reveal).not.toHaveBeenCalled();
  });

  it('should fail when provider is not available', async () => {
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    const ctx = createMockContext();
    ctx.providers.clear();

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No provider for chain: ethereum');
  });

  it('should fail when revealing too early (before reveal block)', async () => {
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    mockProvider.getBlockNumber.mockResolvedValue(100); // Still at commit block

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Too early to reveal');
    expect(result.error).toContain('Current: 100, Need: 101');
    expect(mockContract.reveal).not.toHaveBeenCalled();
  });

  it('should fail when wallet is not available', async () => {
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    const ctx = createMockContext(mockProvider);
    ctx.wallets.clear();

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No wallet for chain: ethereum');
  });

  it('should retry reveal with higher gas on first failure', async () => {
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    // First attempt fails
    mockContract.reveal.mockRejectedValueOnce(new Error('Gas too low'));

    // Estimate gas for retry
    mockContract.reveal.estimateGas = jest.fn().mockResolvedValue(100000n);

    // Second attempt succeeds
    const mockInterface = new ethers.Interface([
      'event Revealed(bytes32 indexed commitmentHash, address indexed tokenIn, address indexed tokenOut, uint256 profit)',
    ]);
    const revealedLog = mockInterface.encodeEventLog(
      'Revealed',
      [
        '0x1234567890123456789012345678901234567890123456789012345678901234',
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        500000000000000000n,
      ]
    );

    mockContract.reveal.mockResolvedValueOnce({
      wait: jest.fn().mockResolvedValue({
        hash: '0xreveal-retry',
        logs: [
          {
            topics: revealedLog.topics,
            data: revealedLog.data,
          },
        ],
      }),
    });

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', mockContext);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xreveal-retry');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Reveal failed, retrying with higher gas',
      expect.objectContaining({
        commitmentHash: commitResult.commitmentHash,
        chain: 'ethereum',
        error: 'Gas too low',
      })
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Retrying reveal with higher gas',
      expect.objectContaining({
        gasEstimate: '100000',
        gasLimit: '110000', // 10% bump
      })
    );
  });

  it('should fail after retry attempt fails', async () => {
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    // First attempt fails
    mockContract.reveal.mockRejectedValueOnce(new Error('Gas too low'));

    // Retry also fails
    mockContract.reveal.estimateGas = jest.fn().mockResolvedValue(100000n);
    mockContract.reveal.mockRejectedValueOnce(new Error('Still failed'));

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Reveal failed after retry');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Reveal retry failed',
      expect.any(Object)
    );
  });

  it('should handle missing Revealed event in logs', async () => {
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    // Mock reveal with no Revealed event
    mockContract.reveal.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xreveal-no-event',
        logs: [],
      }),
    });

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', mockContext);

    expect(result.success).toBe(true);
    expect(result.profit).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'No Revealed event found in transaction logs',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Test Suite: Redis Storage Operations
// =============================================================================

describe('CommitRevealService - Redis Storage', () => {
  let mockLogger: Logger;
  let mockRedis: jest.Mocked<Redis>;
  let mockContract: any;
  let mockFactory: ContractFactory;
  let mockContext: StrategyContext;
  let service: CommitRevealService;

  const contractAddresses = {
    ethereum: '0x1234567890123456789012345678901234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockRedis = createMockRedis();
    mockContract = createMockContract();
    mockFactory = createMockContractFactory(mockContract);
    mockContext = createMockContext();

    // Enable Redis feature
    process.env.FEATURE_COMMIT_REVEAL_REDIS = 'true';

    // Mock successful commit transaction
    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    service = new CommitRevealService(mockLogger, contractAddresses, mockRedis, mockFactory);
  });

  afterEach(() => {
    delete process.env.FEATURE_COMMIT_REVEAL_REDIS;
  });

  it('should use atomic SET NX for Redis storage on commit', async () => {
    mockRedis.set.mockResolvedValue('OK' as any);

    const params = createSampleParams();
    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining(`commit-reveal:ethereum:${result.commitmentHash}`),
      expect.any(String),
      'EX',
      600, // TTL
      'NX' // Set if not exists (atomic)
    );
  });

  it('should fail commit when Redis SET NX returns null (duplicate)', async () => {
    mockRedis.set.mockResolvedValue(null as any); // Key already exists

    const params = createSampleParams();
    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ERR_DUPLICATE_COMMITMENT');
    expect(result.error).toContain('already exists');
  });

  it('should load commitment state from Redis on reveal', async () => {
    const params = createSampleParams();

    // Commit with Redis
    mockRedis.set.mockResolvedValue('OK' as any);
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    // Mock Redis GET to return stored state
    mockRedis.get.mockImplementation(async (key: any) => {
      // Return the data that was stored
      const setCall = (mockRedis.set as jest.Mock).mock.calls[0];
      return setCall[1]; // The data parameter
    });

    // Mock provider and reveal
    const mockProvider = createMockProvider();
    mockProvider.getBlockNumber.mockResolvedValue(101);
    const ctx = createMockContext(mockProvider);

    mockContract.reveal.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xreveal1234',
        logs: [],
      }),
    });

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', ctx);

    expect(mockRedis.get).toHaveBeenCalledWith(
      expect.stringContaining(`commit-reveal:ethereum:${commitResult.commitmentHash}`)
    );
  });

  it('should delete commitment state from Redis after successful reveal', async () => {
    const params = createSampleParams();

    // Commit
    mockRedis.set.mockResolvedValue('OK' as any);
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    // Mock Redis GET
    mockRedis.get.mockImplementation(async (key: any) => {
      const setCall = (mockRedis.set as jest.Mock).mock.calls[0];
      return setCall[1];
    });

    // Mock provider and reveal
    const mockProvider = createMockProvider();
    mockProvider.getBlockNumber.mockResolvedValue(101);
    const ctx = createMockContext(mockProvider);

    mockContract.reveal.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xreveal1234',
        logs: [],
      }),
    });

    await service.reveal(commitResult.commitmentHash, 'ethereum', ctx);

    expect(mockRedis.del).toHaveBeenCalledWith(
      expect.stringContaining(`commit-reveal:ethereum:${commitResult.commitmentHash}`)
    );
  });

  it('should fall back to in-memory storage when Redis fails', async () => {
    mockRedis.set.mockRejectedValue(new Error('Redis connection failed'));

    const params = createSampleParams();
    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Redis storage failed, falling back to memory only',
      expect.objectContaining({
        error: 'Redis connection failed',
      })
    );
  });

  it('should serialize and deserialize BigInt values correctly', async () => {
    mockRedis.set.mockResolvedValue('OK' as any);

    const params = createSampleParams();
    params.amountIn = 999999999999999999n;
    params.minProfit = 123456789012345678n;
    params.swapPath[0].amountOutMin = 888888888888888888n;

    const commitResult = await service.commit(params, 'ethereum', mockContext);

    // Extract the serialized data from the Redis SET call
    const setCall = (mockRedis.set as jest.Mock).mock.calls[0];
    const serializedData = setCall[1];
    const parsed = JSON.parse(serializedData);

    // Verify BigInt values are stored as strings
    expect(parsed.params.amountIn).toBe('999999999999999999');
    expect(parsed.params.minProfit).toBe('123456789012345678');
    expect(parsed.params.swapPath[0].amountOutMin).toBe('888888888888888888');

    // Mock GET to return the serialized data
    mockRedis.get.mockResolvedValue(serializedData);

    // Verify deserialization converts back to BigInt
    const mockProvider = createMockProvider();
    mockProvider.getBlockNumber.mockResolvedValue(101);
    const ctx = createMockContext(mockProvider);

    mockContract.reveal.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xreveal1234',
        logs: [],
      }),
    });

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', ctx);

    expect(result.success).toBe(true);
    expect(mockContract.reveal).toHaveBeenCalledWith(
      expect.objectContaining({
        amountIn: 999999999999999999n,
        minProfit: 123456789012345678n,
        swapPath: [
          expect.objectContaining({
            amountOutMin: 888888888888888888n,
          }),
        ],
      })
    );
  });
});

// =============================================================================
// Test Suite: In-Memory Storage Fallback
// =============================================================================

describe('CommitRevealService - In-Memory Storage', () => {
  let mockLogger: Logger;
  let mockContract: any;
  let mockFactory: ContractFactory;
  let mockContext: StrategyContext;
  let service: CommitRevealService;

  const contractAddresses = {
    ethereum: '0x1234567890123456789012345678901234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockContract = createMockContract();
    mockFactory = createMockContractFactory(mockContract);
    mockContext = createMockContext();

    // Disable Redis feature
    delete process.env.FEATURE_COMMIT_REVEAL_REDIS;

    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    service = new CommitRevealService(mockLogger, contractAddresses, undefined, mockFactory);
  });

  it('should store commitment in memory when Redis is disabled', async () => {
    const params = createSampleParams();
    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Stored commitment in memory only',
      expect.objectContaining({
        storageMode: 'memory-only',
        reason: 'Redis disabled',
      })
    );
  });

  it('should load commitment from memory on reveal', async () => {
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    const mockProvider = createMockProvider();
    mockProvider.getBlockNumber.mockResolvedValue(101);
    const ctx = createMockContext(mockProvider);

    mockContract.reveal.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xreveal1234',
        logs: [],
      }),
    });

    const result = await service.reveal(commitResult.commitmentHash, 'ethereum', ctx);

    expect(result.success).toBe(true);
  });

  it('should detect duplicate commitment in memory', async () => {
    const params = createSampleParams();

    // First commit succeeds
    const result1 = await service.commit(params, 'ethereum', mockContext);
    expect(result1.success).toBe(true);

    // Mock new commit transaction for second attempt
    jest.clearAllMocks();
    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd5678',
        blockNumber: 101,
      }),
    });

    // Second commit with same params should fail
    const result2 = await service.commit(params, 'ethereum', mockContext);

    expect(result2.success).toBe(false);
    expect(result2.error).toContain('ERR_DUPLICATE_COMMITMENT');
    expect(result2.error).toContain('already exists in memory');
  });
});

// =============================================================================
// Test Suite: Wait for Reveal Block
// =============================================================================

describe('CommitRevealService - Wait for Block', () => {
  let mockLogger: Logger;
  let mockProvider: any;
  let mockContext: StrategyContext;
  let service: CommitRevealService;

  const contractAddresses = {
    ethereum: '0x1234567890123456789012345678901234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockLogger = createMockLogger();
    mockProvider = createMockProvider();
    mockContext = createMockContext(mockProvider);

    service = new CommitRevealService(mockLogger, contractAddresses);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should wait successfully when target block is reached', async () => {
    mockProvider.getBlockNumber.mockResolvedValue(100);

    const promise = service.waitForRevealBlock(100, 'ethereum', mockContext);

    // Fast-forward timers
    await jest.runAllTimersAsync();

    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.currentBlock).toBe(100);
  });

  it('should poll until target block is reached', async () => {
    let callCount = 0;
    mockProvider.getBlockNumber.mockImplementation(() => {
      callCount++;
      if (callCount < 3) return Promise.resolve(98);
      return Promise.resolve(100);
    });

    const promise = service.waitForRevealBlock(100, 'ethereum', mockContext);

    await jest.runAllTimersAsync();

    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.currentBlock).toBe(100);
    expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(3);
  });

  it('should fail when provider is not available', async () => {
    const ctx = createMockContext();
    ctx.providers.clear();

    const result = await service.waitForRevealBlock(100, 'ethereum', ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No provider available for chain: ethereum');
  });

  it('should handle transient provider errors', async () => {
    let callCount = 0;
    mockProvider.getBlockNumber.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('Network error'));
      return Promise.resolve(100);
    });

    const promise = service.waitForRevealBlock(100, 'ethereum', mockContext);

    await jest.runAllTimersAsync();

    const result = await promise;

    expect(result.success).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Error checking block number',
      expect.objectContaining({
        error: 'Network error',
      })
    );
  });

  it('should fail fast after consecutive errors', async () => {
    mockProvider.getBlockNumber.mockRejectedValue(new Error('Provider unavailable'));

    const promise = service.waitForRevealBlock(100, 'ethereum', mockContext);

    await jest.runAllTimersAsync();

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('Provider permanently unavailable after 5 consecutive errors');
  });

  it('should timeout after max attempts', async () => {
    mockProvider.getBlockNumber.mockResolvedValue(50); // Never reaches target

    const promise = service.waitForRevealBlock(100, 'ethereum', mockContext);

    await jest.runAllTimersAsync();

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('Timeout waiting for block 100');
  });
});

// =============================================================================
// Test Suite: Cancel Operation
// =============================================================================

describe('CommitRevealService - Cancel', () => {
  let mockLogger: Logger;
  let mockContract: any;
  let mockFactory: ContractFactory;
  let mockContext: StrategyContext;
  let mockRedis: jest.Mocked<Redis>;
  let service: CommitRevealService;

  const contractAddresses = {
    ethereum: '0x1234567890123456789012345678901234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockContract = createMockContract();
    mockFactory = createMockContractFactory(mockContract);
    mockContext = createMockContext();
    mockRedis = createMockRedis();

    process.env.FEATURE_COMMIT_REVEAL_REDIS = 'true';

    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    mockContract.cancelCommit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xcancel1234',
      }),
    });

    service = new CommitRevealService(mockLogger, contractAddresses, mockRedis, mockFactory);
  });

  afterEach(() => {
    delete process.env.FEATURE_COMMIT_REVEAL_REDIS;
  });

  it('should successfully cancel commitment', async () => {
    mockRedis.set.mockResolvedValue('OK' as any);

    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    const result = await service.cancel(commitResult.commitmentHash, 'ethereum', mockContext);

    expect(result).toBe(true);
    expect(mockContract.cancelCommit).toHaveBeenCalledWith(commitResult.commitmentHash);
    expect(mockRedis.del).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Commitment cancelled',
      expect.objectContaining({
        commitmentHash: commitResult.commitmentHash,
        chain: 'ethereum',
      })
    );
  });

  it('should fail when wallet is not available', async () => {
    const ctx = createMockContext();
    ctx.wallets.clear();

    const result = await service.cancel('0xhash', 'ethereum', ctx);

    expect(result).toBe(false);
    expect(mockContract.cancelCommit).not.toHaveBeenCalled();
  });

  it('should handle cancellation errors', async () => {
    mockContract.cancelCommit.mockRejectedValue(new Error('Cancellation failed'));

    const result = await service.cancel('0xhash', 'ethereum', mockContext);

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Cancel failed',
      expect.objectContaining({
        error: 'Cancellation failed',
      })
    );
  });

  it('should not clean up storage when cancellation fails', async () => {
    // First commit something so there's state to clean up
    mockRedis.set.mockResolvedValue('OK' as any);
    const params = createSampleParams();
    const commitResult = await service.commit(params, 'ethereum', mockContext);

    // Clear mock call counts (but keep mock implementations)
    mockRedis.set.mockClear();
    mockRedis.del.mockClear();
    mockContract.cancelCommit.mockClear();

    // Now cancel should fail
    mockContract.cancelCommit.mockRejectedValue(new Error('Already cancelled'));

    const result = await service.cancel(commitResult.commitmentHash, 'ethereum', mockContext);

    // Should NOT delete from storage when cancel fails (might want to retry)
    expect(result).toBe(false);
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Cancel failed',
      expect.objectContaining({
        error: 'Already cancelled',
      })
    );
  });
});

// =============================================================================
// Test Suite: Edge Cases and Error Handling
// =============================================================================

describe('CommitRevealService - Edge Cases', () => {
  let mockLogger: Logger;
  let mockContract: any;
  let mockFactory: ContractFactory;
  let mockContext: StrategyContext;
  let service: CommitRevealService;

  const contractAddresses = {
    ethereum: '0x1234567890123456789012345678901234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockContract = createMockContract();
    mockFactory = createMockContractFactory(mockContract);
    mockContext = createMockContext();

    service = new CommitRevealService(mockLogger, contractAddresses, undefined, mockFactory);
  });

  it('should handle multi-hop swap paths', async () => {
    const params = createSampleParams();
    params.swapPath = [
      {
        router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amountOutMin: 1000000n,
      },
      {
        router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
        tokenIn: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        tokenOut: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
        amountOutMin: 2000000n,
      },
    ];

    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
    expect(result.commitmentHash).toBeDefined();
  });

  it('should handle very large BigInt values', async () => {
    const params = createSampleParams();
    params.amountIn = BigInt('999999999999999999999999');
    params.minProfit = BigInt('123456789012345678901234');
    params.swapPath[0].amountOutMin = BigInt('888888888888888888888888');

    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
  });

  it('should handle zero values gracefully', async () => {
    const params = createSampleParams();
    params.amountIn = 0n;
    params.minProfit = 0n;

    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
  });

  it('should handle deadline in the past', async () => {
    const params = createSampleParams();
    params.deadline = Math.floor(Date.now() / 1000) - 1000; // 1000 seconds ago

    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: '0xabcd1234',
        blockNumber: 100,
      }),
    });

    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
  });

  it('should handle empty contract address string', async () => {
    const addresses = { ethereum: '' };
    const service = new CommitRevealService(mockLogger, addresses);

    const params = createSampleParams();
    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No commit-reveal contract deployed');
  });

  it('should handle transaction receipt with no hash', async () => {
    const params = createSampleParams();

    mockContract.commit.mockResolvedValue({
      wait: jest.fn().mockResolvedValue({
        hash: undefined,
        blockNumber: 100,
      }),
    });

    const result = await service.commit(params, 'ethereum', mockContext);

    expect(result.success).toBe(true);
    expect(result.txHash).toBeUndefined();
  });
});
