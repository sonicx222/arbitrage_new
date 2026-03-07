# @arbitrage/config

Configuration management for 15 chains, 78 DEXs, flash loan providers, bridges, risk controls, and system thresholds. Uses Zod schema validation for type-safe configuration.

## Build Order

**2nd** in build chain: types -> `config` -> core -> ml -> services

## Key Exports

| Category | Exports |
|----------|---------|
| **Chains** | `CHAINS`, `MAINNET_CHAIN_IDS`, `getBlockTimeMs()` |
| **DEXs** | `DEXES`, `getEnabledDexes()`, `DEX_FACTORY_REGISTRY` |
| **Tokens** | `CORE_TOKENS`, `TOKEN_METADATA`, `NATIVE_TOKEN_PRICES` (ADR-040) |
| **Flash Loans** | `FLASH_LOAN_AVAILABILITY`, `FLASH_LOAN_PROVIDERS`, `supportsFlashLoan()` |
| **Bridges** | `BRIDGE_COSTS`, `selectOptimalBridge()` |
| **Thresholds** | `PERFORMANCE_THRESHOLDS`, `ARBITRAGE_CONFIG`, `getMinProfitThreshold()` |
| **Partitions** | `PARTITIONS`, `PARTITION_CONFIG`, execution chain groups (ADR-038) |
| **Addresses** | `AAVE_V3_POOLS`, `NATIVE_TOKENS`, `STABLECOINS` |
| **Validation** | `EthereumAddressSchema`, `ChainSchema`, `DexSchema` (Zod) |
| **Feature Flags** | `FEATURE_FLAGS`, `FLASH_LOAN_AGGREGATOR_CONFIG` |

## Usage

```typescript
import { CHAINS, getEnabledDexes, getMinProfitThreshold } from '@arbitrage/config';
```

## Dependencies

- `@arbitrage/types`
- `zod` (schema validation)
