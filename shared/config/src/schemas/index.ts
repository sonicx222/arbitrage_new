/**
 * Zod Schema Validation for Config Objects
 *
 * P3-CONFIG: Runtime validation for all configuration objects.
 * Prevents runtime failures from malformed configs that pass TypeScript
 * compile-time checks but fail at runtime.
 *
 * @see docs/refactoring-roadmap.md - P3-CONFIG: Add Zod schema validation
 *
 * ## Hot-Path Safety
 * These schemas are used at:
 * - Module load time (validateConfigAtLoad)
 * - Service startup (validateServiceConfig)
 * - Hot-reload events (validateOnReload)
 *
 * Validation is NOT performed in the hot-path detection loop.
 * Once configs are validated at startup, they're trusted during operation.
 */

import { z } from 'zod';

// =============================================================================
// Primitive Schemas
// =============================================================================

/**
 * Ethereum address schema (0x + 40 hex chars).
 * Used for contract addresses, wallet addresses, token addresses.
 */
export const EthereumAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

/**
 * Solana address schema (base58, 32-44 chars).
 * Used for program IDs, token mints, wallet addresses on Solana.
 */
export const SolanaAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana address format');

/**
 * URL schema with protocol validation.
 */
export const UrlSchema = z.string().url('Invalid URL format');

/**
 * WebSocket URL schema.
 */
export const WsUrlSchema = z
  .string()
  .regex(/^wss?:\/\//, 'WebSocket URL must start with ws:// or wss://');

/**
 * RPC URL schema (HTTP or HTTPS).
 */
export const RpcUrlSchema = z
  .string()
  .regex(/^https?:\/\//, 'RPC URL must start with http:// or https://');

/**
 * Basis points (0-10000).
 * 100 bps = 1%, 10000 bps = 100%
 */
export const BasisPointsSchema = z
  .number()
  .int()
  .min(0, 'Basis points cannot be negative')
  .max(10000, 'Basis points cannot exceed 10000 (100%)');

/**
 * Percentage as decimal (0-1).
 */
export const PercentageDecimalSchema = z
  .number()
  .min(0, 'Percentage cannot be negative')
  .max(1, 'Percentage cannot exceed 1 (100%)');

/**
 * Positive integer.
 */
export const PositiveIntSchema = z
  .number()
  .int()
  .positive('Value must be a positive integer');

/**
 * Non-negative integer.
 */
export const NonNegativeIntSchema = z
  .number()
  .int()
  .min(0, 'Value cannot be negative');

// =============================================================================
// Chain Configuration Schemas
// =============================================================================

/**
 * Chain configuration schema.
 * @see shared/types/index.ts - Chain interface
 */
export const ChainSchema = z.object({
  id: PositiveIntSchema.describe('Unique chain identifier (e.g., 1 for Ethereum)'),
  name: z.string().min(1, 'Chain name is required'),
  rpcUrl: RpcUrlSchema.describe('Primary RPC endpoint URL'),
  wsUrl: WsUrlSchema.optional().describe('Primary WebSocket endpoint URL'),
  wsFallbackUrls: z.array(WsUrlSchema).optional().describe('Fallback WebSocket URLs'),
  rpcFallbackUrls: z.array(RpcUrlSchema).optional().describe('Fallback RPC URLs'),
  blockTime: z.number().positive('Block time must be positive').describe('Average block time in seconds'),
  nativeToken: z.string().min(1, 'Native token symbol is required'),
  isEVM: z.boolean().optional().default(true).describe('Whether chain uses EVM'),
});

/**
 * Chain registry schema (chain name -> Chain).
 */
export const ChainRegistrySchema = z.record(z.string(), ChainSchema);

// =============================================================================
// DEX Configuration Schemas
// =============================================================================

/**
 * DEX type classification.
 * @see shared/types/index.ts - DexType
 */
export const DexTypeSchema = z.enum([
  'amm',        // Automated Market Maker (constant product)
  'clmm',       // Concentrated Liquidity Market Maker
  'dlmm',       // Dynamic Liquidity Market Maker
  'orderbook',  // On-chain order book
  'pmm',        // Proactive Market Maker
  'aggregator', // Routes through other DEXs
]);

/**
 * DEX configuration schema.
 * @see shared/types/index.ts - Dex interface
 */
export const DexSchema = z.object({
  name: z.string().min(1, 'DEX name is required'),
  chain: z.string().min(1, 'Chain identifier is required'),
  factoryAddress: EthereumAddressSchema.describe('Factory contract address'),
  routerAddress: EthereumAddressSchema.describe('Router contract address'),
  fee: BasisPointsSchema.describe('Trading fee in basis points (e.g., 30 = 0.30%)'),
  enabled: z.boolean().optional().default(true),
  type: DexTypeSchema.optional(),
});

/**
 * Solana DEX configuration schema.
 * Uses program IDs instead of contract addresses.
 */
export const SolanaDexSchema = z.object({
  name: z.string().min(1, 'DEX name is required'),
  chain: z.literal('solana'),
  programId: SolanaAddressSchema.describe('Solana program ID'),
  fee: BasisPointsSchema.describe('Trading fee in basis points'),
  enabled: z.boolean().optional().default(true),
  type: DexTypeSchema,
});

// =============================================================================
// Factory Configuration Schemas
// =============================================================================

/**
 * Factory type classification.
 * @see shared/config/src/dex-factories.ts - FactoryType
 */
export const FactoryTypeSchema = z.enum([
  'uniswap_v2',   // Standard xy=k AMM
  'uniswap_v3',   // Concentrated liquidity
  'solidly',      // ve(3,3) forks
  'curve',        // StableSwap AMM
  'balancer_v2',  // Vault-based weighted pools
  'algebra',      // Algebra-based concentrated liquidity
  'trader_joe',   // Liquidity Book
]);

/**
 * Factory configuration schema.
 * @see shared/config/src/dex-factories.ts - FactoryConfig
 */
export const FactoryConfigSchema = z.object({
  address: EthereumAddressSchema.describe('Factory contract address'),
  dexName: z.string().min(1, 'DEX name is required'),
  type: FactoryTypeSchema,
  chain: z.string().min(1, 'Chain identifier is required'),
  initCodeHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Init code hash must be 32 bytes (0x + 64 hex chars)')
    .optional(),
  hasFeeTiers: z.boolean().optional(),
  supportsFactoryEvents: z.boolean().optional().default(true),
});

/**
 * Factory registry schema (chain -> factories).
 */
export const FactoryRegistrySchema = z.record(
  z.string(),
  z.array(FactoryConfigSchema)
);

// =============================================================================
// Token Configuration Schemas
// =============================================================================

/**
 * Token configuration schema.
 * @see shared/types/index.ts - Token interface
 */
export const TokenSchema = z.object({
  address: EthereumAddressSchema.describe('Token contract address'),
  symbol: z.string().min(1, 'Token symbol is required').max(20, 'Symbol too long'),
  decimals: z.number().int().min(0).max(18, 'Decimals must be 0-18'),
  chainId: PositiveIntSchema.describe('Chain ID where token exists'),
});

/**
 * Solana token schema.
 */
export const SolanaTokenSchema = z.object({
  address: SolanaAddressSchema.describe('Token mint address'),
  symbol: z.string().min(1).max(20),
  decimals: z.number().int().min(0).max(9, 'Solana tokens have max 9 decimals'),
  chainId: z.literal(101).describe('Solana mainnet chain ID'),
});

// =============================================================================
// Service Configuration Schemas
// =============================================================================

/**
 * Redis configuration schema.
 */
export const RedisConfigSchema = z.object({
  url: UrlSchema.describe('Redis connection URL'),
  password: z.string().optional(),
});

/**
 * Monitoring configuration schema.
 */
export const MonitoringConfigSchema = z.object({
  enabled: z.boolean(),
  interval: PositiveIntSchema.describe('Monitoring interval in milliseconds'),
  endpoints: z.array(z.string()),
});

/**
 * Service configuration schema.
 * @see shared/types/index.ts - ServiceConfig
 */
export const ServiceConfigSchema = z.object({
  name: z.string().min(1, 'Service name is required'),
  version: z.string().regex(/^\d+\.\d+\.\d+/, 'Invalid semver format'),
  environment: z.enum(['development', 'staging', 'production']),
  chains: z.array(ChainSchema),
  dexes: z.array(DexSchema),
  tokens: z.array(TokenSchema),
  redis: RedisConfigSchema,
  monitoring: MonitoringConfigSchema,
});

// =============================================================================
// Flash Loan Configuration Schemas
// =============================================================================

/**
 * Flash loan provider protocol types.
 */
export const FlashLoanProtocolSchema = z.enum([
  'aave_v3',
  'pancakeswap_v3',
  'spookyswap',
  'syncswap',
  'jupiter',
]);

/**
 * Flash loan provider configuration schema.
 */
export const FlashLoanProviderSchema = z.object({
  address: z.string().describe('Provider contract address (empty for non-EVM)'),
  protocol: FlashLoanProtocolSchema,
  fee: BasisPointsSchema.describe('Flash loan fee in basis points'),
});

/**
 * Flash loan providers registry schema.
 */
export const FlashLoanProvidersSchema = z.record(
  z.string(),
  FlashLoanProviderSchema
);

// =============================================================================
// Bridge Configuration Schemas
// =============================================================================

/**
 * Bridge cost configuration schema.
 * @see shared/config/src/service-config.ts - BridgeCostConfig
 */
export const BridgeCostConfigSchema = z.object({
  bridge: z.string().min(1, 'Bridge name is required'),
  sourceChain: z.string().min(1),
  targetChain: z.string().min(1),
  feeBps: BasisPointsSchema.describe('Fee in basis points (6 = 0.06%)'),
  feePercentage: z.number().min(0).max(100).optional(), // @deprecated - backward compatibility
  minFeeUsd: z.number().min(0),
  estimatedLatencySeconds: PositiveIntSchema,
  reliability: PercentageDecimalSchema.describe('Reliability score (0-1)'),
});

/**
 * Bridge costs array schema.
 */
export const BridgeCostsSchema = z.array(BridgeCostConfigSchema);

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validation result with detailed error information.
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: Array<{
    path: string;
    message: string;
  }>;
}

/**
 * Validate data against a schema and return detailed result.
 * Does NOT throw - returns result object for handling.
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validation result with data or errors
 */
export function validateWithDetails<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): ValidationResult<T> {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    errors: result.error.errors.map((e: z.ZodIssue) => ({
      path: e.path.join('.'),
      message: e.message,
    })),
  };
}

/**
 * Validate data and throw on failure.
 * Use at startup/load time, not in hot paths.
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @param context - Context string for error message
 * @throws Error with detailed validation failures
 */
export function validateOrThrow<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context: string
): T {
  const result = schema.safeParse(data);

  if (result.success) {
    return result.data;
  }

  const errorDetails = result.error.errors
    .map((e: z.ZodIssue) => `  - ${e.path.join('.')}: ${e.message}`)
    .join('\n');

  throw new Error(
    `Config validation failed for ${context}:\n${errorDetails}`
  );
}

/**
 * Create a validator function for a specific schema.
 * Useful for repeated validation of the same type.
 *
 * @param schema - Zod schema
 * @param context - Context string for errors
 * @returns Validator function
 */
export function createValidator<T>(
  schema: z.ZodSchema<T>,
  context: string
): (data: unknown) => T {
  return (data: unknown) => validateOrThrow(schema, data, context);
}

// =============================================================================
// Config-Specific Validators
// =============================================================================

/**
 * Validate chain configuration.
 */
export const validateChain = createValidator(ChainSchema, 'Chain');

/**
 * Validate DEX configuration.
 */
export const validateDex = createValidator(DexSchema, 'DEX');

/**
 * Validate factory configuration.
 */
export const validateFactory = createValidator(FactoryConfigSchema, 'Factory');

/**
 * Validate flash loan provider configuration.
 */
export const validateFlashLoanProvider = createValidator(
  FlashLoanProviderSchema,
  'FlashLoanProvider'
);

/**
 * Validate bridge cost configuration.
 */
export const validateBridgeCost = createValidator(
  BridgeCostConfigSchema,
  'BridgeCost'
);

// =============================================================================
// Registry Validators (for startup validation)
// =============================================================================

/**
 * Validate entire chain registry.
 * Call at module load time or service startup.
 */
export function validateChainRegistry(
  registry: unknown,
  skipInTest = true
): void {
  if (skipInTest && process.env.NODE_ENV === 'test') {
    return;
  }

  validateOrThrow(ChainRegistrySchema, registry, 'ChainRegistry');
}

/**
 * Validate entire factory registry.
 * Call at module load time or service startup.
 */
export function validateFactoryRegistry(
  registry: unknown,
  skipInTest = true
): void {
  if (skipInTest && process.env.NODE_ENV === 'test') {
    return;
  }

  validateOrThrow(FactoryRegistrySchema, registry, 'FactoryRegistry');
}

/**
 * Validate flash loan providers.
 */
export function validateFlashLoanProviders(
  providers: unknown,
  skipInTest = true
): void {
  if (skipInTest && process.env.NODE_ENV === 'test') {
    return;
  }

  validateOrThrow(FlashLoanProvidersSchema, providers, 'FlashLoanProviders');
}

/**
 * Validate bridge costs array.
 */
export function validateBridgeCosts(
  costs: unknown,
  skipInTest = true
): void {
  if (skipInTest && process.env.NODE_ENV === 'test') {
    return;
  }

  validateOrThrow(BridgeCostsSchema, costs, 'BridgeCosts');
}

// =============================================================================
// Exports
// =============================================================================

export { z } from 'zod';
