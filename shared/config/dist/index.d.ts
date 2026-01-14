import { Chain, Dex, Token } from '../../types';
export declare const CHAINS: Record<string, Chain>;
export declare const DEXES: Record<string, Dex[]>;
export declare const CORE_TOKENS: Record<string, Token[]>;
export declare const SERVICE_CONFIGS: {
    redis: {
        url: string;
        password: string | undefined;
    };
    monitoring: {
        enabled: boolean;
        interval: number;
        endpoints: string[];
    };
};
export declare const PERFORMANCE_THRESHOLDS: {
    maxEventLatency: number;
    minCacheHitRate: number;
    maxMemoryUsage: number;
    maxCpuUsage: number;
    maxFalsePositiveRate: number;
};
export declare const ARBITRAGE_CONFIG: {
    minProfitPercentage: number;
    maxGasPrice: number;
    confidenceThreshold: number;
    maxTradeSize: string;
    triangularEnabled: boolean;
    crossChainEnabled: boolean;
    predictiveEnabled: boolean;
    defaultAmount: number;
    estimatedGasCost: number;
    opportunityTimeoutMs: number;
    minProfitThreshold: number;
    minConfidenceThreshold: number;
    feePercentage: number;
    slippageTolerance: number;
    gasPriceSpikeMultiplier: number;
    gasPriceBaselineWindowMs: number;
    gasPriceSpikeEnabled: boolean;
    chainMinProfits: Record<string, number>;
};
export declare const EVENT_CONFIG: {
    syncEvents: {
        enabled: boolean;
        priority: string;
    };
    swapEvents: {
        enabled: boolean;
        priority: string;
        minAmountUSD: number;
        whaleThreshold: number;
        samplingRate: number;
    };
};
/**
 * Partition IDs - Use these constants instead of magic strings
 * to prevent typos and enable IDE autocomplete.
 */
export declare const PARTITION_IDS: {
    readonly ASIA_FAST: "asia-fast";
    readonly L2_TURBO: "l2-turbo";
    readonly HIGH_VALUE: "high-value";
    readonly SOLANA_NATIVE: "solana-native";
};
export type PartitionId = typeof PARTITION_IDS[keyof typeof PARTITION_IDS];
/**
 * Partition chain assignments - S3.1.2 configuration
 * Use getChainsForPartition() from partitions.ts for runtime access.
 */
export declare const PARTITION_CONFIG: {
    P1_ASIA_FAST: readonly ["bsc", "polygon", "avalanche", "fantom"];
    P2_L2_TURBO: readonly ["arbitrum", "optimism", "base"];
    P3_HIGH_VALUE: readonly ["ethereum", "zksync", "linea"];
    P4_SOLANA_NATIVE: readonly ["solana"];
};
export declare const PHASE_METRICS: {
    current: {
        phase: number;
        chains: number;
        dexes: number;
        tokens: number;
        targetOpportunities: number;
    };
    targets: {
        phase1: {
            chains: number;
            dexes: number;
            tokens: number;
            opportunities: number;
        };
        phase2: {
            chains: number;
            dexes: number;
            tokens: number;
            opportunities: number;
        };
        phase3: {
            chains: number;
            dexes: number;
            tokens: number;
            opportunities: number;
        };
    };
};
export declare const TOKEN_METADATA: Record<string, {
    weth: string;
    stablecoins: {
        address: string;
        symbol: string;
        decimals: number;
    }[];
    nativeWrapper: string;
}>;
export declare const EVENT_SIGNATURES: {
    SYNC: string;
    SWAP_V2: string;
    SWAP_V3: string;
};
/**
 * Get enabled DEXs for a chain.
 * Filters out DEXs with enabled === false (enabled defaults to true if not specified).
 *
 * @param chainId - The chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of enabled Dex objects for the chain
 */
export declare function getEnabledDexes(chainId: string): Dex[];
/**
 * Convert DEX fee from basis points to percentage.
 * Config stores fees in basis points (e.g., 30 = 0.30%), calculations use percentage.
 *
 * @param feeBasisPoints - Fee in basis points (e.g., 30 for 0.30%)
 * @returns Fee as a decimal percentage (e.g., 0.003 for 0.30%)
 */
export declare function dexFeeToPercentage(feeBasisPoints: number): number;
/**
 * Convert percentage to basis points.
 * Inverse of dexFeeToPercentage.
 *
 * @param percentage - Fee as decimal (e.g., 0.003 for 0.30%)
 * @returns Fee in basis points (e.g., 30 for 0.30%)
 */
export declare function percentageToBasisPoints(percentage: number): number;
export interface DetectorChainConfig {
    batchSize: number;
    batchTimeout: number;
    healthCheckInterval: number;
    confidence: number;
    expiryMs: number;
    gasEstimate: number;
    whaleThreshold: number;
    nativeTokenKey: 'weth' | 'nativeWrapper';
}
export declare const DETECTOR_CONFIG: Record<string, DetectorChainConfig>;
export declare const FLASH_LOAN_PROVIDERS: Record<string, {
    address: string;
    protocol: string;
    fee: number;
}>;
/**
 * P1-5 FIX: Bridge cost configuration to replace hardcoded multipliers.
 * Fees are in basis points (1 bp = 0.01%). Latency in seconds.
 *
 * Data sources:
 * - Stargate: https://stargate.finance/bridge (fees vary by route)
 * - Across: https://across.to/ (dynamic fees)
 * - LayerZero: https://layerzero.network/ (gas-dependent fees)
 *
 * Note: These are baseline estimates. Production should use real-time API data.
 */
export interface BridgeCostConfig {
    bridge: string;
    sourceChain: string;
    targetChain: string;
    feePercentage: number;
    minFeeUsd: number;
    estimatedLatencySeconds: number;
    reliability: number;
}
export declare const BRIDGE_COSTS: BridgeCostConfig[];
/**
 * P1-5 FIX: Get bridge cost for a specific route
 */
export declare function getBridgeCost(sourceChain: string, targetChain: string, bridge?: string): BridgeCostConfig | undefined;
/**
 * P1-5 FIX: Calculate bridge cost for a given USD amount
 */
export declare function calculateBridgeCostUsd(sourceChain: string, targetChain: string, amountUsd: number, bridge?: string): {
    fee: number;
    latency: number;
    bridge: string;
} | undefined;
export declare const SYSTEM_CONSTANTS: {
    redis: {
        /** Maximum message size in bytes for Redis pub/sub (1MB) */
        maxMessageSize: number;
        /** Maximum channel name length */
        maxChannelNameLength: number;
        /** Default SCAN batch size for iterating keys */
        scanBatchSize: number;
        /** Default TTL for health data in seconds */
        healthDataTtl: number;
        /** Default TTL for metrics data in seconds */
        metricsDataTtl: number;
        /** Maximum rolling metrics entries */
        maxRollingMetrics: number;
        /** Disconnect timeout in milliseconds */
        disconnectTimeout: number;
    };
    cache: {
        /** Average entry size estimate in bytes for L1 capacity calculation */
        averageEntrySize: number;
        /** Default L1 cache size in MB */
        defaultL1SizeMb: number;
        /** Default L2 TTL in seconds */
        defaultL2TtlSeconds: number;
        /** Auto-demotion threshold in milliseconds */
        demotionThresholdMs: number;
        /** Minimum access count before demotion */
        minAccessCountBeforeDemotion: number;
    };
    selfHealing: {
        /** Circuit breaker recovery cooldown in milliseconds */
        circuitBreakerCooldownMs: number;
        /** Health check failure threshold before recovery */
        healthCheckFailureThreshold: number;
        /** Graceful degradation failure threshold */
        gracefulDegradationThreshold: number;
        /** Maximum restart delay in milliseconds */
        maxRestartDelayMs: number;
        /** Simulated restart delay for testing in milliseconds */
        simulatedRestartDelayMs: number;
        /** Simulated restart failure rate (0-1) */
        simulatedRestartFailureRate: number;
    };
    webSocket: {
        /** Default reconnect delay in milliseconds */
        defaultReconnectDelayMs: number;
        /** Maximum reconnect delay in milliseconds */
        maxReconnectDelayMs: number;
        /** Reconnect backoff multiplier */
        reconnectBackoffMultiplier: number;
        /** Maximum reconnect attempts */
        maxReconnectAttempts: number;
        /** Connection timeout in milliseconds */
        connectionTimeoutMs: number;
    };
    circuitBreaker: {
        /** Default failure threshold */
        defaultFailureThreshold: number;
        /** Default recovery timeout in milliseconds */
        defaultRecoveryTimeoutMs: number;
        /** Default monitoring period in milliseconds */
        defaultMonitoringPeriodMs: number;
        /** Default success threshold for closing */
        defaultSuccessThreshold: number;
    };
};
/**
 * Cross-chain token aliases for identifying equivalent tokens across chains.
 * Maps chain-specific token symbols to their canonical form.
 *
 * Purpose: Enable cross-chain arbitrage detection by recognizing that
 * WETH.e (Avalanche), ETH (BSC), and WETH (most chains) are all the same asset.
 *
 * Note: This is DIFFERENT from price-oracle's TOKEN_ALIASES which maps
 * wrapped tokens to native for pricing (WETH→ETH). Here we use WETH as
 * canonical because it's the actual tradeable asset on DEXes.
 *
 * @see services/cross-chain-detector/src/detector.ts
 * @see shared/core/src/price-oracle.ts (different purpose)
 */
export declare const CROSS_CHAIN_TOKEN_ALIASES: Readonly<Record<string, string>>;
/**
 * Normalize a token symbol to its canonical form for cross-chain comparison.
 * This enables identifying equivalent tokens across different chains.
 *
 * Examples:
 * - normalizeTokenForCrossChain('WETH.e') → 'WETH'  (Avalanche bridged ETH)
 * - normalizeTokenForCrossChain('ETH') → 'WETH'     (BSC bridged ETH)
 * - normalizeTokenForCrossChain('fUSDT') → 'USDT'   (Fantom USDT)
 * - normalizeTokenForCrossChain('BTCB') → 'WBTC'    (BSC wrapped BTC)
 * - normalizeTokenForCrossChain('USDC') → 'USDC'    (passthrough)
 *
 * @param symbol - The token symbol to normalize
 * @returns The canonical token symbol for cross-chain comparison
 */
export declare function normalizeTokenForCrossChain(symbol: string): string;
/**
 * Find common tokens between two chains using normalized comparison.
 * Returns canonical token symbols that exist on both chains.
 *
 * @param chainA - First chain ID
 * @param chainB - Second chain ID
 * @returns Array of canonical token symbols common to both chains
 */
export declare function findCommonTokensBetweenChains(chainA: string, chainB: string): string[];
/**
 * Get the chain-specific token symbol for a canonical symbol.
 * Useful for building pair keys when you know the canonical token.
 *
 * @param chainId - The chain ID
 * @param canonicalSymbol - The canonical token symbol (e.g., 'WETH')
 * @returns The chain-specific symbol (e.g., 'WETH.e' on Avalanche) or undefined
 */
export declare function getChainSpecificTokenSymbol(chainId: string, canonicalSymbol: string): string | undefined;
export * from './partitions';
export { PARTITIONS, PartitionConfig, getPartition, getPartitionFromEnv, assignChainToPartition } from './partitions';
//# sourceMappingURL=index.d.ts.map