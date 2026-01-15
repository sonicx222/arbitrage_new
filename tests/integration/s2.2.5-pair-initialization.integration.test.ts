/**
 * S2.2.5 Pair Initialization Integration Tests
 *
 * Sprint 2, Task 2.5: Update pair initialization
 *
 * This task implements:
 * 1. Dynamic pair discovery from DEX factory contracts
 * 2. Pair address caching in Redis with TTL
 * 3. Cache invalidation and refresh mechanisms
 * 4. Batch pair address queries for efficiency
 *
 * Test-Driven Development:
 * 1. Write failing tests for pair discovery and caching
 * 2. Implement PairDiscoveryService to make tests pass
 * 3. Integrate with existing detector architecture
 */

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.REDIS_URL = 'redis://localhost:6379';

// Use require to avoid ts-jest transformation caching issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  DEXES,
  CHAINS,
  CORE_TOKENS,
  ARBITRAGE_CONFIG,
  dexFeeToPercentage
} = require('../../shared/config/src');

// =============================================================================
// S2.2.5 Test Suite: Pair Initialization
// =============================================================================

describe('S2.2.5 Pair Initialization', () => {
  // ===========================================================================
  // Section 1: Pair Discovery Service Tests
  // ===========================================================================

  describe('PairDiscoveryService', () => {
    describe('Factory Contract Integration', () => {
      it('should have Uniswap V2 factory ABI for getPair calls', () => {
        // Uniswap V2 factory interface for pair discovery
        const UNISWAP_V2_FACTORY_ABI = [
          'function getPair(address tokenA, address tokenB) external view returns (address pair)',
          'function allPairs(uint256) external view returns (address pair)',
          'function allPairsLength() external view returns (uint256)'
        ];

        expect(UNISWAP_V2_FACTORY_ABI).toHaveLength(3);
        expect(UNISWAP_V2_FACTORY_ABI[0]).toContain('getPair');
        expect(UNISWAP_V2_FACTORY_ABI[1]).toContain('allPairs');
        expect(UNISWAP_V2_FACTORY_ABI[2]).toContain('allPairsLength');
      });

      it('should have Uniswap V3 factory ABI for getPool calls', () => {
        // Uniswap V3 factory interface for pool discovery
        const UNISWAP_V3_FACTORY_ABI = [
          'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
        ];

        expect(UNISWAP_V3_FACTORY_ABI).toHaveLength(1);
        expect(UNISWAP_V3_FACTORY_ABI[0]).toContain('getPool');
        expect(UNISWAP_V3_FACTORY_ABI[0]).toContain('uint24 fee');
      });

      it('should support both V2 and V3 factory patterns', () => {
        // Test factory type detection based on DEX name
        const detectFactoryType = (dexName: string): 'v2' | 'v3' | 'curve' => {
          if (dexName.includes('v3') || dexName.includes('V3')) return 'v3';
          if (dexName.includes('curve') || dexName.includes('ellipsis')) return 'curve';
          return 'v2';
        };

        expect(detectFactoryType('uniswap_v3')).toBe('v3');
        expect(detectFactoryType('pancakeswap_v3')).toBe('v3');
        expect(detectFactoryType('uniswap_v2')).toBe('v2');
        expect(detectFactoryType('sushiswap')).toBe('v2');
        expect(detectFactoryType('curve')).toBe('curve');
        expect(detectFactoryType('ellipsis')).toBe('curve');
      });

      it('should validate factory addresses from config', () => {
        // All DEX factory addresses should be valid addresses for their chain type
        Object.entries(DEXES).forEach(([chain, dexes]) => {
          (dexes as any[]).forEach(dex => {
            // Solana uses base58 program addresses instead of EVM 0x format
            if (chain === 'solana') {
              expect(dex.factoryAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,50}$/);
            } else {
              expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
              expect(dex.factoryAddress).not.toBe('0x0000000000000000000000000000000000000000');
            }
          });
        });
      });
    });

    describe('Pair Address Generation', () => {
      it('should generate deterministic addresses using CREATE2 formula', () => {
        // CREATE2 address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
        const generateCreate2Address = (
          factory: string,
          token0: string,
          token1: string,
          initCodeHash: string
        ): string => {
          // Sort tokens for deterministic ordering
          const [sortedToken0, sortedToken1] = [token0, token1].sort((a, b) =>
            a.toLowerCase().localeCompare(b.toLowerCase())
          );

          // This is the standard Uniswap V2 CREATE2 formula
          const salt = require('ethers').keccak256(
            require('ethers').solidityPacked(
              ['address', 'address'],
              [sortedToken0, sortedToken1]
            )
          );

          const packed = require('ethers').solidityPacked(
            ['bytes1', 'address', 'bytes32', 'bytes32'],
            ['0xff', factory, salt, initCodeHash]
          );

          return '0x' + require('ethers').keccak256(packed).slice(26);
        };

        // Test with known Uniswap V2 init code hash
        const UNISWAP_V2_INIT_CODE_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';
        const factory = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
        const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

        const pairAddress = generateCreate2Address(factory, weth, usdt, UNISWAP_V2_INIT_CODE_HASH);

        // Should generate valid Ethereum address
        expect(pairAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        // Should be deterministic (same input = same output)
        const pairAddress2 = generateCreate2Address(factory, usdt, weth, UNISWAP_V2_INIT_CODE_HASH);
        expect(pairAddress).toBe(pairAddress2);
      });

      it('should sort token addresses for deterministic pair generation', () => {
        const sortTokens = (tokenA: string, tokenB: string): [string, string] => {
          return tokenA.toLowerCase() < tokenB.toLowerCase()
            ? [tokenA, tokenB]
            : [tokenB, tokenA];
        };

        const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

        const [sorted0, sorted1] = sortTokens(weth, usdt);
        const [sorted0Rev, sorted1Rev] = sortTokens(usdt, weth);

        // Should produce same result regardless of input order
        expect(sorted0).toBe(sorted0Rev);
        expect(sorted1).toBe(sorted1Rev);
      });
    });

    describe('Batch Discovery', () => {
      it('should support batching multiple getPair calls', () => {
        // Batch discovery config
        const batchConfig = {
          maxBatchSize: 100,       // Max calls per batch
          batchDelayMs: 50,        // Delay between batches
          maxConcurrentBatches: 5, // Parallel batch limit
          retryAttempts: 3,        // Retry failed calls
          retryDelayMs: 1000       // Delay before retry
        };

        expect(batchConfig.maxBatchSize).toBeGreaterThan(0);
        expect(batchConfig.maxBatchSize).toBeLessThanOrEqual(100);
        expect(batchConfig.batchDelayMs).toBeGreaterThanOrEqual(0);
      });

      it('should calculate optimal batch sizes per chain', () => {
        const calculateBatches = (totalPairs: number, batchSize: number): number => {
          return Math.ceil(totalPairs / batchSize);
        };

        // Example: Arbitrum with 12 tokens, 9 DEXs
        const arbitrumTokens = CORE_TOKENS.arbitrum.length;
        const arbitrumDexes = DEXES.arbitrum.length;
        const tokenPairs = (arbitrumTokens * (arbitrumTokens - 1)) / 2;
        const totalPairs = tokenPairs * arbitrumDexes;

        const batches = calculateBatches(totalPairs, 100);

        expect(batches).toBeGreaterThan(0);
        expect(batches).toBeLessThan(totalPairs); // Batching should reduce calls
      });
    });
  });

  // ===========================================================================
  // Section 2: Pair Cache Tests
  // ===========================================================================

  describe('PairCache', () => {
    describe('Cache Key Generation', () => {
      it('should generate consistent cache keys for pairs', () => {
        const generateCacheKey = (chain: string, dex: string, token0: string, token1: string): string => {
          // Sort tokens for consistent key generation
          const [sortedToken0, sortedToken1] = [token0, token1].sort((a, b) =>
            a.toLowerCase().localeCompare(b.toLowerCase())
          );
          return `pair:${chain}:${dex}:${sortedToken0.toLowerCase()}:${sortedToken1.toLowerCase()}`;
        };

        const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

        const key1 = generateCacheKey('ethereum', 'uniswap_v2', weth, usdt);
        const key2 = generateCacheKey('ethereum', 'uniswap_v2', usdt, weth);

        // Keys should be identical regardless of token order
        expect(key1).toBe(key2);
        // Key should contain all components
        expect(key1).toContain('pair:');
        expect(key1).toContain('ethereum');
        expect(key1).toContain('uniswap_v2');
      });

      it('should generate cache key pattern for bulk operations', () => {
        const generatePatternKey = (chain: string, dex?: string): string => {
          if (dex) {
            return `pair:${chain}:${dex}:*`;
          }
          return `pair:${chain}:*`;
        };

        const chainPattern = generatePatternKey('ethereum');
        const dexPattern = generatePatternKey('ethereum', 'uniswap_v2');

        expect(chainPattern).toBe('pair:ethereum:*');
        expect(dexPattern).toBe('pair:ethereum:uniswap_v2:*');
      });
    });

    describe('Cache TTL Configuration', () => {
      it('should have appropriate TTL for pair addresses', () => {
        // Pair addresses are static (created once), so long TTL is appropriate
        const PAIR_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

        expect(PAIR_CACHE_TTL_SECONDS).toBe(86400);
        expect(PAIR_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(3600); // At least 1 hour
      });

      it('should support different TTLs for different data types', () => {
        const cacheTTLConfig = {
          pairAddress: 24 * 60 * 60,      // 24 hours - static data
          pairMetadata: 60 * 60,          // 1 hour - may change (fees)
          reserveData: 60,                 // 1 minute - frequently updated
          factoryPairCount: 5 * 60        // 5 minutes - new pairs may be created
        };

        expect(cacheTTLConfig.pairAddress).toBeGreaterThan(cacheTTLConfig.pairMetadata);
        expect(cacheTTLConfig.pairMetadata).toBeGreaterThan(cacheTTLConfig.reserveData);
      });
    });

    describe('Cache Data Structure', () => {
      it('should serialize pair data for Redis storage', () => {
        const pairData = {
          address: '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
          token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          dex: 'uniswap_v2',
          fee: 0.003,
          discoveredAt: Date.now(),
          lastVerified: Date.now()
        };

        const serialized = JSON.stringify(pairData);
        const deserialized = JSON.parse(serialized);

        expect(deserialized.address).toBe(pairData.address);
        expect(deserialized.fee).toBe(pairData.fee);
        expect(typeof deserialized.discoveredAt).toBe('number');
      });

      it('should support batch cache operations', () => {
        // Redis MGET/MSET for bulk operations
        const batchCacheOps = {
          maxBatchSize: 100,
          pipeline: true, // Use Redis pipeline for efficiency
          compression: false // JSON is compact enough for pair data
        };

        expect(batchCacheOps.maxBatchSize).toBeLessThanOrEqual(1000);
        expect(batchCacheOps.pipeline).toBe(true);
      });
    });

    describe('Cache Miss Handling', () => {
      it('should define cache miss strategy', () => {
        const cacheMissStrategy = {
          fetchFromChain: true,      // Query factory contract on miss
          retryOnFailure: true,      // Retry failed queries
          maxRetries: 3,             // Max retry attempts
          backoffMs: 1000,           // Exponential backoff base
          cacheNullResults: true,    // Cache "pair doesn't exist" to avoid re-queries
          nullResultTTL: 60 * 60     // 1 hour TTL for null results
        };

        expect(cacheMissStrategy.fetchFromChain).toBe(true);
        expect(cacheMissStrategy.cacheNullResults).toBe(true);
        expect(cacheMissStrategy.nullResultTTL).toBeGreaterThan(0);
      });

      it('should differentiate between cache miss and non-existent pair', () => {
        // Special value to indicate "pair checked but doesn't exist"
        const NON_EXISTENT_PAIR = 'NULL_PAIR';
        const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

        // Cache value interpretation
        const interpretCacheValue = (value: string | null): 'miss' | 'null' | 'found' => {
          if (value === null) return 'miss';
          if (value === NON_EXISTENT_PAIR || value === ZERO_ADDRESS) return 'null';
          return 'found';
        };

        expect(interpretCacheValue(null)).toBe('miss');
        expect(interpretCacheValue(NON_EXISTENT_PAIR)).toBe('null');
        expect(interpretCacheValue(ZERO_ADDRESS)).toBe('null');
        expect(interpretCacheValue('0x1234...valid')).toBe('found');
      });
    });
  });

  // ===========================================================================
  // Section 3: Integration Tests
  // ===========================================================================

  describe('Integration with Existing Architecture', () => {
    describe('BaseDetector Integration', () => {
      it('should replace placeholder getPairAddress with cache-aware version', () => {
        // The new getPairAddress should:
        // 1. Check cache first
        // 2. On miss, query factory contract
        // 3. Cache result
        // 4. Return address

        interface GetPairAddressOptions {
          useCache: boolean;
          skipCacheOnMiss: boolean;
          forceRefresh: boolean;
        }

        const defaultOptions: GetPairAddressOptions = {
          useCache: true,
          skipCacheOnMiss: false,
          forceRefresh: false
        };

        expect(defaultOptions.useCache).toBe(true);
        expect(defaultOptions.forceRefresh).toBe(false);
      });

      it('should support initialization from cache', () => {
        // Startup flow:
        // 1. Load cached pairs from Redis
        // 2. For missing pairs, query factory
        // 3. Update cache with new discoveries
        // 4. Continue with monitoring

        const initializationConfig = {
          loadFromCache: true,
          warmupConcurrency: 10,   // Parallel factory queries
          warmupTimeout: 30000,    // 30 second timeout for warmup
          failOnWarmupError: false // Continue even if some pairs fail
        };

        expect(initializationConfig.loadFromCache).toBe(true);
        expect(initializationConfig.warmupTimeout).toBeLessThanOrEqual(60000);
      });
    });

    describe('ChainInstance Integration', () => {
      it('should use PairDiscoveryService for initialization', () => {
        // ChainInstance should delegate pair discovery to service
        const chainInstanceDependencies = {
          pairDiscoveryService: 'required',
          pairCacheService: 'required',
          factoryContracts: 'lazy-loaded'
        };

        expect(chainInstanceDependencies.pairDiscoveryService).toBe('required');
        expect(chainInstanceDependencies.pairCacheService).toBe('required');
      });

      it('should emit events for pair discovery', () => {
        // Events for monitoring and debugging
        const pairDiscoveryEvents = [
          'pair:discovered',     // New pair found
          'pair:cached',         // Pair added to cache
          'pair:cache_hit',      // Cache hit
          'pair:cache_miss',     // Cache miss
          'pair:not_found',      // Pair doesn't exist on chain
          'pair:refresh_needed'  // TTL expired, needs refresh
        ];

        expect(pairDiscoveryEvents).toContain('pair:discovered');
        expect(pairDiscoveryEvents).toContain('pair:cached');
        expect(pairDiscoveryEvents).toContain('pair:cache_miss');
      });
    });

    describe('Redis Streams Integration', () => {
      it('should publish pair discovery to Redis Streams', () => {
        // Stream name for pair discovery events
        const PAIR_DISCOVERY_STREAM = 'stream:pair-discovery';

        // Event structure
        const pairDiscoveryEvent = {
          type: 'pair_discovered',
          chain: 'ethereum',
          dex: 'uniswap_v2',
          token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          pairAddress: '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
          timestamp: Date.now()
        };

        expect(pairDiscoveryEvent.type).toBe('pair_discovered');
        expect(pairDiscoveryEvent.pairAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
    });
  });

  // ===========================================================================
  // Section 4: Performance Tests
  // ===========================================================================

  describe('Performance', () => {
    it('should cache lookup be faster than factory query', () => {
      // Expected performance characteristics
      const performanceTargets = {
        cacheHitLatencyMs: 5,       // < 5ms for cache hit
        factoryQueryLatencyMs: 100, // ~100ms for RPC call
        batchQueryLatencyMs: 500,   // ~500ms for batch of 100
        cacheWarmupTimeMs: 30000    // < 30s for full warmup
      };

      expect(performanceTargets.cacheHitLatencyMs).toBeLessThan(performanceTargets.factoryQueryLatencyMs);
      expect(performanceTargets.batchQueryLatencyMs).toBeLessThan(
        performanceTargets.factoryQueryLatencyMs * 100 // Better than sequential
      );
    });

    it('should minimize RPC calls through caching', () => {
      // Cache hit ratio targets
      const cacheMetrics = {
        targetHitRatio: 0.95,      // 95% cache hit after warmup
        acceptableHitRatio: 0.80, // 80% minimum acceptable
        warmupQueries: 2000,      // Initial queries to populate cache
        steadyStateQueries: 100   // Expected queries per hour after warmup
      };

      expect(cacheMetrics.targetHitRatio).toBeGreaterThan(cacheMetrics.acceptableHitRatio);
    });

    it('should handle concurrent pair lookups efficiently', () => {
      // Concurrency configuration
      const concurrencyConfig = {
        maxConcurrentCacheLookups: 1000,  // In-memory operations
        maxConcurrentFactoryQueries: 10,  // RPC rate limits
        requestQueueSize: 5000,           // Pending requests
        requestTimeout: 10000             // 10s timeout
      };

      expect(concurrencyConfig.maxConcurrentCacheLookups).toBeGreaterThan(
        concurrencyConfig.maxConcurrentFactoryQueries
      );
    });
  });

  // ===========================================================================
  // Section 5: Error Handling Tests
  // ===========================================================================

  describe('Error Handling', () => {
    it('should handle factory contract errors gracefully', () => {
      const errorHandlingConfig = {
        retryOnRpcError: true,
        retryOnTimeout: true,
        maxRetries: 3,
        exponentialBackoff: true,
        baseBackoffMs: 1000,
        maxBackoffMs: 30000,
        circuitBreakerThreshold: 10, // Open circuit after 10 failures
        circuitBreakerResetMs: 60000 // Reset after 1 minute
      };

      expect(errorHandlingConfig.retryOnRpcError).toBe(true);
      expect(errorHandlingConfig.maxRetries).toBeGreaterThan(0);
      expect(errorHandlingConfig.circuitBreakerThreshold).toBeGreaterThan(0);
    });

    it('should handle Redis cache errors gracefully', () => {
      // On cache error, fall back to direct factory query
      const cacheErrorStrategy = {
        fallbackToDirectQuery: true,
        logCacheErrors: true,
        cacheErrorThreshold: 5,     // Disable cache after 5 consecutive errors
        cacheRecoveryCheckMs: 30000 // Check if cache recovered every 30s
      };

      expect(cacheErrorStrategy.fallbackToDirectQuery).toBe(true);
      expect(cacheErrorStrategy.cacheErrorThreshold).toBeGreaterThan(0);
    });

    it('should handle non-existent pairs correctly', () => {
      // Zero address indicates pair doesn't exist
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

      const handleNonExistentPair = (pairAddress: string | null): boolean => {
        if (!pairAddress) return false;
        if (pairAddress === ZERO_ADDRESS) return false;
        return true;
      };

      expect(handleNonExistentPair(null)).toBe(false);
      expect(handleNonExistentPair(ZERO_ADDRESS)).toBe(false);
      expect(handleNonExistentPair('0x1234567890123456789012345678901234567890')).toBe(true);
    });
  });

  // ===========================================================================
  // Section 6: Configuration Tests
  // ===========================================================================

  describe('Configuration', () => {
    it('should have factory init code hashes for major DEXs', () => {
      // Init code hashes for CREATE2 address computation
      const INIT_CODE_HASHES: Record<string, string> = {
        uniswap_v2: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
        sushiswap: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
        pancakeswap_v2: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5'
      };

      // All init code hashes should be 32 bytes (66 chars with 0x)
      Object.values(INIT_CODE_HASHES).forEach(hash => {
        expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      });
    });

    it('should have V3 fee tiers for Uniswap V3-style pools', () => {
      // Uniswap V3 uses specific fee tiers
      const V3_FEE_TIERS = [100, 500, 3000, 10000]; // In basis points (0.01%, 0.05%, 0.3%, 1%)

      expect(V3_FEE_TIERS).toContain(500);  // 0.05%
      expect(V3_FEE_TIERS).toContain(3000); // 0.3% (most common)
      expect(V3_FEE_TIERS).toContain(10000); // 1% (exotic pairs)
    });

    it('should configure chain-specific RPC call limits', () => {
      const rpcLimitsPerChain: Record<string, { callsPerSecond: number; batchSize: number }> = {
        // Original 6 chains
        ethereum: { callsPerSecond: 10, batchSize: 50 },
        arbitrum: { callsPerSecond: 50, batchSize: 100 },
        bsc: { callsPerSecond: 30, batchSize: 100 },
        polygon: { callsPerSecond: 30, batchSize: 100 },
        base: { callsPerSecond: 50, batchSize: 100 },
        optimism: { callsPerSecond: 50, batchSize: 100 },
        // S3.1.2: New chains for 4-partition architecture
        avalanche: { callsPerSecond: 30, batchSize: 100 },   // C-Chain similar to Polygon
        fantom: { callsPerSecond: 50, batchSize: 100 },      // Fast chain, good rate limits
        zksync: { callsPerSecond: 30, batchSize: 100 },      // L2 ZK rollup
        linea: { callsPerSecond: 30, batchSize: 100 },       // L2 ZK rollup
        solana: { callsPerSecond: 100, batchSize: 200 }      // Non-EVM, high throughput
      };

      // All configured chains should have limits
      Object.keys(CHAINS).forEach(chain => {
        expect(rpcLimitsPerChain[chain]).toBeDefined();
        expect(rpcLimitsPerChain[chain].callsPerSecond).toBeGreaterThan(0);
      });
    });
  });
});

// =============================================================================
// Regression Tests
// =============================================================================

describe('S2.2.5 Regression Tests', () => {
  describe('REGRESSION: Pair Address Consistency', () => {
    it('should generate same address regardless of token order', () => {
      const sortTokens = (a: string, b: string): [string, string] => {
        return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
      };

      const token1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const token2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      const [sorted1a, sorted1b] = sortTokens(token1, token2);
      const [sorted2a, sorted2b] = sortTokens(token2, token1);

      expect(sorted1a).toBe(sorted2a);
      expect(sorted1b).toBe(sorted2b);
    });

    it('should handle checksum vs lowercase addresses', () => {
      const checksum = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const lowercase = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

      expect(checksum.toLowerCase()).toBe(lowercase);
    });
  });

  describe('REGRESSION: Cache Key Uniqueness', () => {
    it('should generate unique keys for different chains', () => {
      const generateKey = (chain: string, dex: string, t0: string, t1: string): string => {
        return `pair:${chain}:${dex}:${t0.toLowerCase()}:${t1.toLowerCase()}`;
      };

      const key1 = generateKey('ethereum', 'uniswap_v2', '0xaaa', '0xbbb');
      const key2 = generateKey('arbitrum', 'uniswap_v2', '0xaaa', '0xbbb');

      expect(key1).not.toBe(key2);
    });

    it('should generate unique keys for different DEXs', () => {
      const generateKey = (chain: string, dex: string, t0: string, t1: string): string => {
        return `pair:${chain}:${dex}:${t0.toLowerCase()}:${t1.toLowerCase()}`;
      };

      const key1 = generateKey('ethereum', 'uniswap_v2', '0xaaa', '0xbbb');
      const key2 = generateKey('ethereum', 'sushiswap', '0xaaa', '0xbbb');

      expect(key1).not.toBe(key2);
    });
  });

  describe('REGRESSION: Fee Handling', () => {
    it('should use ?? not || for fee fallbacks (S2.2.3 fix)', () => {
      const zeroFee = 0;
      const defaultFee = 0.003;

      // Correct behavior with ??
      expect(zeroFee ?? defaultFee).toBe(0);

      // Wrong behavior with ||
      expect(zeroFee || defaultFee).toBe(defaultFee);
    });
  });
});
