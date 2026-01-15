/**
 * DEX Adapters Module
 *
 * Vault-model and pool-model DEX adapters for non-factory pattern DEXes.
 *
 * Supported DEXes:
 * - Balancer V2 / Beethoven X: Vault model with poolIds
 * - GMX: Single vault with token whitelist
 * - Platypus: Pool model for stablecoins
 *
 * @see ADR-003: Partitioned Detector Strategy
 */

// Types
export * from './types';

// Adapters
export { BalancerV2Adapter } from './balancer-v2-adapter';
export { GmxAdapter } from './gmx-adapter';
export { PlatypusAdapter } from './platypus-adapter';

// Registry
export { AdapterRegistry, getAdapterRegistry, resetAdapterRegistry } from './adapter-registry';
