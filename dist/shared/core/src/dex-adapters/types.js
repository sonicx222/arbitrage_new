"use strict";
/**
 * DEX Adapter Types
 *
 * Interfaces for vault-model and pool-model DEX adapters.
 * These adapters enable interaction with DEXes that don't follow
 * the standard factory pattern (getPair/getPool).
 *
 * Supported DEX patterns:
 * - Balancer V2 / Beethoven X: Vault model with poolIds
 * - GMX: Single vault with token whitelist
 * - Platypus: Pool model for stablecoins
 *
 * @see ADR-003: Partitioned Detector Strategy
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATYPUS_POOL_ABI = exports.GMX_READER_ABI = exports.GMX_VAULT_ABI = exports.BALANCER_VAULT_ABI = exports.SUBGRAPH_URLS = exports.PLATYPUS_ADDRESSES = exports.GMX_ADDRESSES = exports.BALANCER_VAULT_ADDRESSES = void 0;
exports.success = success;
exports.failure = failure;
// =============================================================================
// Constants
// =============================================================================
/**
 * Balancer V2 Vault addresses by chain
 */
exports.BALANCER_VAULT_ADDRESSES = {
    arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    polygon: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    optimism: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    base: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    // Beethoven X on Fantom uses same interface
    fantom: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',
};
/**
 * GMX contract addresses by chain
 */
exports.GMX_ADDRESSES = {
    avalanche: {
        vault: '0x9ab2De34A33fB459b538c43f251eB825645e8595',
        reader: '0x67b789D48c926006F5132BFCe4e976F0A7A63d5D',
    },
    arbitrum: {
        vault: '0x489ee077994B6658eAfA855C308275EAd8097C4A',
        reader: '0x22199a49A999c351eF7927602CFB187ec3cae489',
    },
};
/**
 * Platypus contract addresses by chain
 */
exports.PLATYPUS_ADDRESSES = {
    avalanche: {
        pool: '0x66357dCaCe80431aee0A7507e2E361B7e2402370',
        router: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12',
    },
};
/**
 * Subgraph URLs for pool discovery
 */
exports.SUBGRAPH_URLS = {
    'balancer_v2:arbitrum': 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2',
    'balancer_v2:ethereum': 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2',
    'balancer_v2:polygon': 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-v2',
    'beethoven_x:fantom': 'https://api.thegraph.com/subgraphs/name/beethovenxfi/beethovenx',
};
// =============================================================================
// ABIs
// =============================================================================
/**
 * Balancer V2 Vault ABI (minimal for our needs)
 */
exports.BALANCER_VAULT_ABI = [
    'function getPoolTokens(bytes32 poolId) external view returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock)',
    'function getPool(bytes32 poolId) external view returns (address, uint8)',
];
/**
 * GMX Vault ABI (minimal for our needs)
 */
exports.GMX_VAULT_ABI = [
    'function whitelistedTokens(uint256 index) external view returns (address)',
    'function whitelistedTokenCount() external view returns (uint256)',
    'function getMinPrice(address token) external view returns (uint256)',
    'function getMaxPrice(address token) external view returns (uint256)',
    'function poolAmounts(address token) external view returns (uint256)',
    'function usdgAmounts(address token) external view returns (uint256)',
    'function getRedemptionAmount(address token, uint256 usdgAmount) external view returns (uint256)',
];
/**
 * GMX Reader ABI
 */
exports.GMX_READER_ABI = [
    'function getAmountOut(address vault, address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256, uint256)',
];
/**
 * Platypus Pool ABI
 */
exports.PLATYPUS_POOL_ABI = [
    'function getAssetOf(address token) external view returns (address)',
    'function getTokenAddresses() external view returns (address[] memory)',
    'function getCash(address token) external view returns (uint256)',
    'function getLiability(address token) external view returns (uint256)',
    'function quotePotentialSwap(address fromToken, address toToken, uint256 fromAmount) external view returns (uint256 potentialOutcome, uint256 haircut)',
];
/**
 * Helper to create success result
 */
function success(data) {
    return { success: true, data };
}
/**
 * Helper to create failure result
 */
function failure(error) {
    return { success: false, error };
}
//# sourceMappingURL=types.js.map