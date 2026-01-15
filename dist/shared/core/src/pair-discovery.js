"use strict";
/**
 * Pair Discovery Service
 *
 * S2.2.5: Dynamic pair discovery from DEX factory contracts
 *
 * Features:
 * - Query factory contracts for pair addresses (V2 and V3 patterns)
 * - CREATE2 address computation for offline pair address generation
 * - Batch discovery for efficiency
 * - Circuit breaker for RPC error handling
 *
 * @see ADR-002: Redis Streams for event publishing
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PairDiscoveryService = void 0;
exports.getPairDiscoveryService = getPairDiscoveryService;
exports.resetPairDiscoveryService = resetPairDiscoveryService;
const ethers_1 = require("ethers");
const events_1 = require("events");
const logger_1 = require("./logger");
// Factory ABIs
const UNISWAP_V2_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    'function allPairs(uint256) external view returns (address pair)',
    'function allPairsLength() external view returns (uint256)'
];
const UNISWAP_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];
// Init code hashes for CREATE2 address computation
const INIT_CODE_HASHES = {
    uniswap_v2: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
    sushiswap: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
    pancakeswap_v2: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5',
    pancakeswap_v3: '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2',
    quickswap: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
    camelot_v3: '0x6c78ee8add0fa881098d2f46bfc8d6f60ac5b78e5f7f0f6d0a6a6f8c2e8f3c4d',
    aerodrome: '0x97e8aa7e58d4c17c8aa7b2cf56b0a36bd0e4e3b8e5f7f0f6d0a6a6f8c2e8f3c4e',
    // S3.2.1-FIX: Added Avalanche DEX init code hashes
    trader_joe_v2: '0x0bbca9af0511ad1a1da383135cf3a8d2ac620e549ef9f6ae3a4c33c2fed0af91',
    pangolin: '0x40231f6b438bce0797c9ada29b718a87ea0a5cea3fe9a771abdd76bd41a3e545',
    // S3.2.2-FIX: Added Fantom DEX init code hashes
    spookyswap: '0xcdf2deca40a0bd56de8e3ce5c7df6727e5b1bf2ac96f283fa9c4b3e6b42ea9d2',
    spiritswap: '0xe242e798f6cee26a9cb0bbf24653bf066e5356ffeac160907fe2cc108e238617',
    equalizer: '0x02ada2a0163cd4f7e0f0c9805f5230716a95b174140e4c84c14883de216cc6a3'
};
// V3 fee tiers (in basis points for pool identification)
const V3_FEE_TIERS = [100, 500, 3000, 10000];
// =============================================================================
// Pair Discovery Service
// =============================================================================
class PairDiscoveryService extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.logger = (0, logger_1.createLogger)('pair-discovery');
        this.providers = new Map();
        this.factoryContracts = new Map();
        // Circuit breaker state
        this.failureCount = new Map();
        this.circuitOpenUntil = new Map();
        // Statistics
        this.stats = {
            totalQueries: 0,
            cacheHits: 0,
            factoryQueries: 0,
            create2Computations: 0,
            failedQueries: 0,
            circuitBreakerTrips: 0,
            avgQueryLatencyMs: 0
        };
        // Rolling latencies for average calculation (fixed-size for memory safety)
        this.queryLatencies = [];
        this.MAX_LATENCY_SAMPLES = 1000;
        // Concurrency control for batch operations
        this.activeQueries = 0;
        this.config = {
            maxConcurrentQueries: 10,
            batchSize: 50,
            batchDelayMs: 100,
            retryAttempts: 3,
            retryDelayMs: 1000,
            circuitBreakerThreshold: 10,
            circuitBreakerResetMs: 60000,
            queryTimeoutMs: 10000,
            ...config
        };
    }
    // ===========================================================================
    // Initialization
    // ===========================================================================
    /**
     * Initialize provider for a chain
     */
    setProvider(chain, provider) {
        this.providers.set(chain, provider);
        this.logger.debug(`Provider set for chain: ${chain}`);
    }
    /**
     * Get or create factory contract instance
     *
     * S3.2.1-FIX: Returns null for unsupported DEX types (vault/pool models, Curve)
     * to prevent creating contracts with wrong ABIs that would fail at runtime
     */
    getFactoryContract(chain, dex) {
        const key = `${chain}:${dex.name}`;
        if (this.factoryContracts.has(key)) {
            return this.factoryContracts.get(key);
        }
        const provider = this.providers.get(chain);
        if (!provider) {
            this.logger.warn(`No provider for chain: ${chain}`);
            return null;
        }
        const factoryType = this.detectFactoryType(dex.name);
        // S3.2.1-FIX: Don't create contracts for unsupported or Curve DEXs
        // These require custom adapters and would fail with standard ABIs
        if (factoryType === 'unsupported' || factoryType === 'curve') {
            this.logger.debug(`DEX ${dex.name} uses ${factoryType} pattern, contract creation skipped`);
            return null;
        }
        const abi = factoryType === 'v3' ? UNISWAP_V3_FACTORY_ABI : UNISWAP_V2_FACTORY_ABI;
        const contract = new ethers_1.ethers.Contract(dex.factoryAddress, abi, provider);
        this.factoryContracts.set(key, contract);
        return contract;
    }
    // ===========================================================================
    // Pair Discovery
    // ===========================================================================
    /**
     * Discover pair address using the best available method
     */
    async discoverPair(chain, dex, token0, token1) {
        this.stats.totalQueries++;
        // Check circuit breaker
        if (this.isCircuitOpen(chain, dex.name)) {
            // Fall back to CREATE2 computation
            return this.computePairAddress(chain, dex, token0, token1);
        }
        const startTime = Date.now();
        try {
            // Try factory query first
            const queryResult = await this.queryFactory(chain, dex, token0, token1);
            if (queryResult && queryResult.address && queryResult.address !== ethers_1.ethers.ZeroAddress) {
                this.stats.factoryQueries++;
                this.recordLatency(Date.now() - startTime);
                this.resetFailureCount(chain, dex.name);
                // S3.2.1-FIX: Sort tokens for consistent ordering (matches CREATE2 computation)
                // This ensures the same pair discovered via factory query or CREATE2 has identical token order
                const [sortedToken0, sortedToken1] = this.sortTokens(token0.address, token1.address);
                const pair = {
                    address: queryResult.address,
                    token0: sortedToken0,
                    token1: sortedToken1,
                    dex: dex.name,
                    chain,
                    factoryAddress: dex.factoryAddress,
                    discoveredAt: Date.now(),
                    discoveryMethod: 'factory_query',
                    // Include V3 fee tier if available (e.g., 500 = 0.05%, 3000 = 0.3%)
                    feeTier: queryResult.feeTier
                };
                this.emit('pair:discovered', pair);
                return pair;
            }
            // Pair doesn't exist on this DEX
            return null;
        }
        catch (error) {
            this.stats.failedQueries++;
            this.incrementFailureCount(chain, dex.name);
            this.logger.warn(`Factory query failed for ${dex.name}`, {
                chain,
                error: error.message
            });
            // Fall back to CREATE2 computation
            return this.computePairAddress(chain, dex, token0, token1);
        }
    }
    /**
     * Query factory contract for pair address with retry support
     * Returns PoolQueryResult with address and optional fee tier
     */
    async queryFactory(chain, dex, token0, token1) {
        const contract = this.getFactoryContract(chain, dex);
        if (!contract)
            return null;
        const factoryType = this.detectFactoryType(dex.name);
        // S3.2.1-FIX: Early return for unsupported DEX types (vault/pool models)
        if (factoryType === 'unsupported') {
            this.logger.debug(`DEX ${dex.name} uses unsupported factory pattern (vault/pool model)`);
            return null;
        }
        // Retry wrapper
        let lastError = null;
        for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
            try {
                if (attempt > 0) {
                    // Exponential backoff
                    const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                const result = await this.queryFactoryOnce(contract, factoryType, token0, token1);
                return result;
            }
            catch (error) {
                lastError = error;
                if (error.message === 'Query timeout') {
                    this.logger.debug(`Query timeout for ${dex.name}, attempt ${attempt + 1}/${this.config.retryAttempts}`);
                }
            }
        }
        throw lastError || new Error('Query failed after retries');
    }
    /**
     * Single factory query with proper timeout handling
     * Returns PoolQueryResult with address and optional fee tier for V3 pools
     *
     * S3.2.1-FIX: Added explicit handling for Curve-style DEXs
     * Curve uses a different pool registry pattern that requires custom adapter
     */
    async queryFactoryOnce(contract, factoryType, token0, token1) {
        const timeoutMs = this.config.queryTimeoutMs;
        if (factoryType === 'v3') {
            // V3: Query all fee tiers in parallel for better performance
            const poolPromises = V3_FEE_TIERS.map(async (feeTier) => {
                try {
                    const result = await this.withTimeout(contract.getPool(token0.address, token1.address, feeTier), timeoutMs);
                    // Return both address and fee tier
                    return { address: result, feeTier };
                }
                catch {
                    return null;
                }
            });
            const results = await Promise.all(poolPromises);
            // Return first valid pool with its fee tier
            for (const result of results) {
                if (result && result.address && result.address !== ethers_1.ethers.ZeroAddress) {
                    return result;
                }
            }
            return null;
        }
        else if (factoryType === 'curve') {
            // S3.2.1-FIX: Curve uses pool registry pattern, not standard getPair/getPool
            // Curve pools are multi-asset and require custom adapter for proper discovery
            // Return null to trigger CREATE2 fallback or indicate pair discovery not supported
            this.logger.debug('Curve-style DEXs require custom pool registry adapter');
            return null;
        }
        else {
            // V2: Direct getPair call with timeout (no fee tier)
            const pairAddress = await this.withTimeout(contract.getPair(token0.address, token1.address), timeoutMs);
            return pairAddress ? { address: pairAddress } : null;
        }
    }
    /**
     * Create a timeout promise with cleanup capability
     * Returns a tuple of [timeoutPromise, cleanup function]
     */
    createTimeoutWithCleanup(ms) {
        let timeoutId;
        const promise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Query timeout')), ms);
        });
        const cleanup = () => clearTimeout(timeoutId);
        return [promise, cleanup];
    }
    /**
     * Execute a promise with timeout, ensuring timer cleanup
     */
    async withTimeout(promise, timeoutMs) {
        const [timeoutPromise, cleanup] = this.createTimeoutWithCleanup(timeoutMs);
        try {
            return await Promise.race([promise, timeoutPromise]);
        }
        finally {
            cleanup();
        }
    }
    /**
     * Compute pair address using CREATE2 formula
     */
    computePairAddress(chain, dex, token0, token1) {
        const initCodeHash = this.getInitCodeHash(dex.name);
        if (!initCodeHash) {
            this.logger.debug(`No init code hash for ${dex.name}, cannot compute address`);
            return null;
        }
        // Sort tokens for deterministic address
        const [sortedToken0, sortedToken1] = this.sortTokens(token0.address, token1.address);
        // CREATE2 address computation
        const salt = ethers_1.ethers.keccak256(ethers_1.ethers.solidityPacked(['address', 'address'], [sortedToken0, sortedToken1]));
        const packed = ethers_1.ethers.solidityPacked(['bytes1', 'address', 'bytes32', 'bytes32'], ['0xff', dex.factoryAddress, salt, initCodeHash]);
        const address = '0x' + ethers_1.ethers.keccak256(packed).slice(26);
        this.stats.create2Computations++;
        const pair = {
            address,
            token0: sortedToken0,
            token1: sortedToken1,
            dex: dex.name,
            chain,
            factoryAddress: dex.factoryAddress,
            discoveredAt: Date.now(),
            discoveryMethod: 'create2_compute'
        };
        this.emit('pair:discovered', pair);
        return pair;
    }
    /**
     * Batch discover multiple pairs with concurrency control
     */
    async discoverPairsBatch(chain, dex, tokenPairs) {
        const results = [];
        this.logger.info(`Discovering pairs with concurrency limit`, {
            chain,
            dex: dex.name,
            totalPairs: tokenPairs.length,
            maxConcurrent: this.config.maxConcurrentQueries
        });
        // Proper semaphore implementation using promise chaining
        // Each slot tracks its own promise chain, ensuring operations are serialized per slot
        const semaphoreSlots = new Array(this.config.maxConcurrentQueries)
            .fill(null)
            .map(() => Promise.resolve());
        let slotIndex = 0;
        const processWithConcurrency = async (token0, token1) => {
            // Get next slot (round-robin)
            const mySlot = slotIndex++ % this.config.maxConcurrentQueries;
            // Chain onto the slot's current promise
            const previousPromise = semaphoreSlots[mySlot];
            // Create a new promise for this operation and update the slot
            let resolveSlot;
            const slotPromise = new Promise(resolve => {
                resolveSlot = resolve;
            });
            semaphoreSlots[mySlot] = slotPromise;
            // Wait for the previous operation in this slot to complete
            await previousPromise;
            // Track active queries
            this.activeQueries++;
            try {
                const result = await this.discoverPair(chain, dex, token0, token1);
                return result;
            }
            finally {
                this.activeQueries--;
                // Release the slot for the next operation
                resolveSlot();
            }
        };
        // Process in batches with delay between batches
        for (let i = 0; i < tokenPairs.length; i += this.config.batchSize) {
            const batch = tokenPairs.slice(i, i + this.config.batchSize);
            // Process batch with concurrency limit
            const batchPromises = batch.map(({ token0, token1 }) => processWithConcurrency(token0, token1));
            const batchResults = await Promise.all(batchPromises);
            for (const result of batchResults) {
                if (result) {
                    results.push(result);
                }
            }
            // Delay between batches to avoid rate limiting
            if (this.config.batchDelayMs > 0 && i + this.config.batchSize < tokenPairs.length) {
                await new Promise(resolve => setTimeout(resolve, this.config.batchDelayMs));
            }
        }
        this.logger.info(`Batch discovery complete`, {
            chain,
            dex: dex.name,
            discovered: results.length,
            total: tokenPairs.length
        });
        return results;
    }
    // ===========================================================================
    // Helper Methods
    // ===========================================================================
    /**
     * Detect factory type based on DEX name
     *
     * S3.2.1-FIX: Added handling for:
     * - KyberSwap Elastic (concentrated liquidity, uses getPool like V3)
     * - GMX and Platypus are NOT supported (vault/pool models, not factory patterns)
     *   These DEXs should have enabled: false in config until adapters are implemented
     *
     * @returns 'v2' for Uniswap V2-style DEXs (getPair method)
     * @returns 'v3' for Uniswap V3-style DEXs (getPool method with fee tiers)
     * @returns 'curve' for Curve-style DEXs (multi-asset pools)
     * @returns 'unsupported' for DEXs that don't follow factory patterns
     */
    detectFactoryType(dexName) {
        const nameLower = dexName.toLowerCase();
        // V3-style DEXs (concentrated liquidity with fee tiers)
        if (nameLower.includes('v3') || nameLower.includes('_v3'))
            return 'v3';
        // S3.2.1-FIX: KyberSwap Elastic uses concentrated liquidity (V3-style getPool)
        if (nameLower.includes('kyberswap') || nameLower.includes('kyber'))
            return 'v3';
        // Curve-style DEXs (multi-asset stable pools)
        if (nameLower.includes('curve') || nameLower.includes('ellipsis'))
            return 'curve';
        // S3.2.1-FIX: DEXs that don't follow factory patterns (vault/pool models)
        // These cannot use getPair/getPool and need custom adapters
        if (nameLower.includes('gmx') || nameLower.includes('platypus'))
            return 'unsupported';
        // S3.2.2-FIX: Balancer V2 vault model DEXs - all use Vault pattern, not standard factory
        // Includes: Balancer V2, Beethoven X (Fantom), and any other Balancer forks
        if (nameLower.includes('balancer') ||
            nameLower.includes('beethoven') ||
            nameLower.includes('beets'))
            return 'unsupported';
        // Default: V2-style DEXs (standard getPair method)
        return 'v2';
    }
    /**
     * Get init code hash for a DEX
     */
    getInitCodeHash(dexName) {
        // Check exact match first
        if (INIT_CODE_HASHES[dexName]) {
            return INIT_CODE_HASHES[dexName];
        }
        // Try to find a matching pattern
        const nameLower = dexName.toLowerCase();
        for (const [key, hash] of Object.entries(INIT_CODE_HASHES)) {
            if (nameLower.includes(key.replace('_', '').toLowerCase())) {
                return hash;
            }
        }
        // Default to Uniswap V2 hash for V2-style DEXs
        if (this.detectFactoryType(dexName) === 'v2') {
            return INIT_CODE_HASHES.uniswap_v2;
        }
        return null;
    }
    /**
     * Sort token addresses for deterministic ordering
     */
    sortTokens(tokenA, tokenB) {
        return tokenA.toLowerCase() < tokenB.toLowerCase()
            ? [tokenA, tokenB]
            : [tokenB, tokenA];
    }
    // ===========================================================================
    // Circuit Breaker
    // ===========================================================================
    isCircuitOpen(chain, dexName) {
        const key = `${chain}:${dexName}`;
        const openUntil = this.circuitOpenUntil.get(key);
        if (openUntil && Date.now() < openUntil) {
            return true;
        }
        // Reset if circuit has recovered
        if (openUntil) {
            this.circuitOpenUntil.delete(key);
            this.failureCount.delete(key);
        }
        return false;
    }
    incrementFailureCount(chain, dexName) {
        const key = `${chain}:${dexName}`;
        const count = (this.failureCount.get(key) || 0) + 1;
        this.failureCount.set(key, count);
        if (count >= this.config.circuitBreakerThreshold) {
            this.circuitOpenUntil.set(key, Date.now() + this.config.circuitBreakerResetMs);
            this.stats.circuitBreakerTrips++;
            this.logger.warn(`Circuit breaker opened for ${key}`, {
                failures: count,
                resetMs: this.config.circuitBreakerResetMs
            });
            this.emit('circuit:opened', { chain, dex: dexName });
        }
    }
    resetFailureCount(chain, dexName) {
        const key = `${chain}:${dexName}`;
        this.failureCount.delete(key);
    }
    // ===========================================================================
    // Statistics
    // ===========================================================================
    recordLatency(latencyMs) {
        this.queryLatencies.push(latencyMs);
        // Keep rolling window of latencies (memory-bounded)
        if (this.queryLatencies.length > this.MAX_LATENCY_SAMPLES) {
            this.queryLatencies.shift();
        }
        // Update average
        this.stats.avgQueryLatencyMs =
            this.queryLatencies.reduce((a, b) => a + b, 0) / this.queryLatencies.length;
    }
    /**
     * Increment cache hits counter (called by external cache integration)
     */
    incrementCacheHits() {
        this.stats.cacheHits++;
    }
    /**
     * Get current active query count
     */
    getActiveQueries() {
        return this.activeQueries;
    }
    getStats() {
        return { ...this.stats };
    }
    /**
     * Reset statistics to initial values
     */
    resetStats() {
        this.stats = {
            totalQueries: 0,
            cacheHits: 0,
            factoryQueries: 0,
            create2Computations: 0,
            failedQueries: 0,
            circuitBreakerTrips: 0,
            avgQueryLatencyMs: 0
        };
        this.queryLatencies = [];
    }
    /**
     * Cleanup resources and reset internal state
     * Call this before disposing the service
     */
    cleanup() {
        this.providers.clear();
        this.factoryContracts.clear();
        this.failureCount.clear();
        this.circuitOpenUntil.clear();
        this.queryLatencies = [];
        this.activeQueries = 0;
        this.removeAllListeners();
        this.logger.info('PairDiscoveryService cleaned up');
    }
    /**
     * Get Prometheus-format metrics
     */
    getPrometheusMetrics() {
        return [
            `# HELP pair_discovery_total Total pair discovery queries`,
            `# TYPE pair_discovery_total counter`,
            `pair_discovery_total ${this.stats.totalQueries}`,
            ``,
            `# HELP pair_discovery_cache_hits Cache hits`,
            `# TYPE pair_discovery_cache_hits counter`,
            `pair_discovery_cache_hits ${this.stats.cacheHits}`,
            ``,
            `# HELP pair_discovery_factory_queries Factory contract queries`,
            `# TYPE pair_discovery_factory_queries counter`,
            `pair_discovery_factory_queries ${this.stats.factoryQueries}`,
            ``,
            `# HELP pair_discovery_create2_computations CREATE2 address computations`,
            `# TYPE pair_discovery_create2_computations counter`,
            `pair_discovery_create2_computations ${this.stats.create2Computations}`,
            ``,
            `# HELP pair_discovery_failures Failed queries`,
            `# TYPE pair_discovery_failures counter`,
            `pair_discovery_failures ${this.stats.failedQueries}`,
            ``,
            `# HELP pair_discovery_circuit_breaker_trips Circuit breaker trips`,
            `# TYPE pair_discovery_circuit_breaker_trips counter`,
            `pair_discovery_circuit_breaker_trips ${this.stats.circuitBreakerTrips}`,
            ``,
            `# HELP pair_discovery_latency_ms Average query latency`,
            `# TYPE pair_discovery_latency_ms gauge`,
            `pair_discovery_latency_ms ${this.stats.avgQueryLatencyMs.toFixed(2)}`
        ].join('\n');
    }
}
exports.PairDiscoveryService = PairDiscoveryService;
// Export singleton factory
let pairDiscoveryInstance = null;
const logger = (0, logger_1.createLogger)('pair-discovery');
/**
 * Get or create singleton PairDiscoveryService instance.
 * Note: Config is only applied on first call. Subsequent calls with different
 * config will log a warning and return the existing instance.
 */
function getPairDiscoveryService(config) {
    if (!pairDiscoveryInstance) {
        pairDiscoveryInstance = new PairDiscoveryService(config);
    }
    else if (config) {
        // Warn if config is passed to existing instance
        logger.warn('getPairDiscoveryService called with config but instance already exists. Config ignored.');
    }
    return pairDiscoveryInstance;
}
function resetPairDiscoveryService() {
    pairDiscoveryInstance = null;
}
//# sourceMappingURL=pair-discovery.js.map