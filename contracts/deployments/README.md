# Contract Deployments Registry

This directory contains deployed contract addresses and deployment metadata for all flash loan arbitrage contracts across supported chains.

## Directory Structure

```
contracts/deployments/
├── README.md                    # This file - documentation
├── addresses.ts                 # Contract address constants (manually updated)
├── index.ts                     # Public exports
├── registry.json                # Deployment metadata (auto-updated by scripts)
├── __tests__/                   # Test suite
│   └── addresses.test.ts
└── [FUTURE] Auto-generated files:
    ├── addresses.generated.ts   # Auto-generated from registry.json
    └── *-registry.json          # Per-contract-type registries
```

## Registry Files

### Current Implementation (Single Registry)

**`registry.json`** - Central deployment registry for all contract types:
```json
{
  "ethereum": {
    "FlashLoanArbitrage": "0x...",
    "MultiPathQuoter": "0x...",
    "PancakeSwapFlashArbitrage": null,
    "BalancerV2FlashArbitrage": null,
    "SyncSwapFlashArbitrage": null,
    "CommitRevealArbitrage": null,
    "deployedAt": 1234567890,
    "deployedBy": "0x...",
    "verified": true
  }
}
```

**Status**: ✅ Active
**Updated by**: Deployment scripts automatically via `deployment-utils.ts`
**Manual edits**: ❌ Not recommended (scripts overwrite)

### Future Implementation (Multi-Registry)

Planned separation for better organization:

- `flash-loan-registry.json` - FlashLoanArbitrage (Aave V3)
- `balancer-registry.json` - BalancerV2FlashArbitrage
- `pancakeswap-registry.json` - PancakeSwapFlashArbitrage
- `syncswap-registry.json` - SyncSwapFlashArbitrage
- `commit-reveal-registry.json` - CommitRevealArbitrage
- `multi-path-quoter-registry.json` - MultiPathQuoter

**Status**: 🚧 Planned (see Issue 1.1 in DEEP_DIVE_ANALYSIS_FINDINGS.md)
**Blocker**: Requires refactoring deployment scripts to specify registry file

## Address Constants

### `addresses.ts` - TypeScript Constants

**Purpose**: Type-safe contract address constants for use in TypeScript services.

**Export Structure**:
```typescript
// Contract addresses by type
export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = { ... };
export const MULTI_PATH_QUOTER_ADDRESSES: Record<string, string> = { ... };
export const PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = { ... };
export const BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = { ... };
export const SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = { ... };
export const COMMIT_REVEAL_ARBITRAGE_ADDRESSES: Record<string, string> = { ... };

// Protocol addresses (re-exported from @arbitrage/config)
export const AAVE_V3_POOL_ADDRESSES = AAVE_V3_POOLS;

// DEX router addresses (pre-approved for swaps)
export const APPROVED_ROUTERS: Record<string, string[]> = { ... };

// Common token addresses for testing
export const TOKEN_ADDRESSES: Record<string, Record<string, string>> = { ... };
```

**Update Process**: ⚠️ **Currently MANUAL** (see "Deployment Workflow" below)

**Future**: Auto-generate from `registry.json` (see "Auto-Generation Plan")

## Deployment Workflow

### Current Process (Manual)

1. **Deploy Contract**:
   ```bash
   # Example: Deploy FlashLoanArbitrage to Sepolia
   npx hardhat run scripts/deploy.ts --network sepolia
   ```

2. **Script Output**:
   ```
   ✅ Contract deployed at: 0x1234...5678
   📝 Registry updated: contracts/deployments/registry.json

   📋 NEXT STEPS:
   1. Update contract address in configuration:
      File: contracts/deployments/addresses.ts
      Update: FLASH_LOAN_CONTRACT_ADDRESSES.sepolia = '0x1234...5678';
   ```

3. **Manual Update Required**:
   ```typescript
   // contracts/deployments/addresses.ts
   export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = {
     sepolia: '0x1234...5678', // ← Manually add this line
   };
   ```

4. **Commit Changes**:
   ```bash
   git add contracts/deployments/addresses.ts contracts/deployments/registry.json
   git commit -m "deploy: FlashLoanArbitrage to Sepolia"
   ```

**⚠️ Risk**: Manual updates are error-prone (typos, forgotten updates, stale addresses)

### Future Process (Auto-Generated)

**Goal**: Eliminate manual address updates

1. **Deploy Contract**: Same as current
2. **Auto-Generate**: Script updates `registry.json` and auto-generates `addresses.ts`
3. **Review & Commit**: Developer reviews diffs and commits

```bash
# Future workflow
npx hardhat run scripts/deploy.ts --network sepolia
# ✅ registry.json updated
# ✅ addresses.generated.ts auto-created from registry.json

git add contracts/deployments/
git commit -m "deploy: FlashLoanArbitrage to Sepolia"
```

**Status**: 🚧 Planned (see Issue 2.1 in DEEP_DIVE_ANALYSIS_FINDINGS.md)

## Helper Functions

### Address Lookup

```typescript
import { getContractAddress, hasDeployedContract } from '@arbitrage/contracts/deployments';

// Check if deployed
if (hasDeployedContract('ethereum')) {
  const address = getContractAddress('ethereum');
  // Use address...
}

// Get with error handling
try {
  const address = getContractAddress('ethereum');
} catch (error) {
  // Handle [ERR_NO_CONTRACT]
}
```

### Chain Name Normalization

Handles zkSync alias variants:

```typescript
import { normalizeChainName } from '@arbitrage/contracts/deployments';

normalizeChainName('zksync-mainnet'); // → 'zksync'
normalizeChainName('zksync-sepolia'); // → 'zksync-testnet'
normalizeChainName('ethereum'); // → 'ethereum' (unchanged)
```

All helper functions automatically normalize chain names, so you can use any variant:

```typescript
getContractAddress('zksync-mainnet'); // Works (normalizes to 'zksync')
getContractAddress('zksync'); // Works (canonical name)
```

### Router Addresses

```typescript
import { getApprovedRouters, hasApprovedRouters } from '@arbitrage/contracts/deployments';

// Check if routers configured
if (hasApprovedRouters('ethereum')) {
  const routers = getApprovedRouters('ethereum');
  // ['0x7a250...', '0xd9e1c...'] - Uniswap V2, SushiSwap
}
```

### Optional Quoter Address

```typescript
import { tryGetQuoterAddress, getQuoterAddress } from '@arbitrage/contracts/deployments';

// Graceful fallback (returns undefined if not deployed)
const quoter = tryGetQuoterAddress('ethereum');
if (quoter) {
  // Use batched quoter
} else {
  // Fall back to sequential quotes
}

// Throws if not deployed (use when quoter is required)
const quoter = getQuoterAddress('ethereum'); // Throws [ERR_NO_QUOTER] if not deployed
```

## Validation

### Module-Load Validation

All addresses are validated at module load time (fail fast):

```typescript
// Validates automatically when addresses.ts is imported
import { getContractAddress } from '@arbitrage/contracts/deployments';

// If any address is invalid:
// ❌ CRITICAL: Invalid address configuration detected
// [ERR_INVALID_ADDRESS] Invalid address format in FLASH_LOAN_CONTRACT_ADDRESSES.ethereum
// Process exits before execution
```

**Validation checks**:
- ✅ Format: `0x` + 40 hex characters
- ✅ Not zero address (`0x000...000`)
- ✅ Not null/undefined/empty string

**Skip validation**: Only in test environment (`NODE_ENV=test`)

### Pre-Deployment Validation

Before deploying to mainnet:

```bash
# Check all addresses are valid
npm run typecheck

# Run tests
npm test contracts/deployments

# Validate deployed addresses match configuration
npm run validate:addresses  # TODO: Implement
```

## Chain Support

### Supported Chains (Mainnet)

- Ethereum (`ethereum`)
- Arbitrum (`arbitrum`)
- Base (`base`)
- Optimism (`optimism`)
- Polygon (`polygon`)
- BSC (`bsc`)
- Avalanche (`avalanche`)
- Fantom (`fantom`)
- zkSync Era (`zksync` or `zksync-mainnet`)
- Linea (`linea`)

### Testnets

- Sepolia (`sepolia`)
- Arbitrum Sepolia (`arbitrumSepolia`)
- zkSync Sepolia (`zksync-testnet` or `zksync-sepolia`)

## Contract Types

### 1. FlashLoanArbitrage (Aave V3)

**File**: `contracts/src/FlashLoanArbitrage.sol`
**Flash Loan Source**: Aave V3 Pool
**Fee**: 0.09% (9 bps)
**Chains**: All EVM chains with Aave V3

**Deployment**:
```bash
npx hardhat run scripts/deploy.ts --network <chain>
```

### 2. PancakeSwapFlashArbitrage

**File**: `contracts/src/PancakeSwapFlashArbitrage.sol`
**Flash Loan Source**: PancakeSwap V3 Pools
**Fee**: Varies by pool (typically 0%)
**Chains**: BSC, Ethereum, Arbitrum, Base, zkSync, Linea

**Deployment**:
```bash
npx hardhat run scripts/deploy-pancakeswap.ts --network <chain>
```

### 3. BalancerV2FlashArbitrage

**File**: `contracts/src/BalancerV2FlashArbitrage.sol`
**Flash Loan Source**: Balancer V2 Vault
**Fee**: 0% (0 bps)
**Chains**: Ethereum, Polygon, Arbitrum, Optimism, Base, Fantom

**Deployment**:
```bash
npx hardhat run scripts/deploy-balancer.ts --network <chain>
```

### 4. SyncSwapFlashArbitrage

**File**: `contracts/src/SyncSwapFlashArbitrage.sol`
**Flash Loan Source**: SyncSwap Vault (EIP-3156)
**Fee**: 0.30% (30 bps)
**Chains**: zkSync Era only

**Deployment**:
```bash
npx hardhat run scripts/deploy-syncswap.ts --network zksync
```

### 5. CommitRevealArbitrage (MEV Protection)

**File**: `contracts/src/CommitRevealArbitrage.sol`
**Purpose**: Two-step commit-reveal pattern to prevent front-running
**Chains**: All EVM chains

**Deployment**:
```bash
npx hardhat run scripts/deploy-commit-reveal.ts --network <chain>
```

### 6. MultiPathQuoter (Utility)

**File**: `contracts/src/MultiPathQuoter.sol`
**Purpose**: Batch multiple `getAmountsOut()` calls into single RPC request
**Latency Reduction**: ~150ms → ~50ms (75-83% improvement)
**Chains**: All EVM chains

**Deployment**:
```bash
npx hardhat run scripts/deploy-multi-path-quoter.ts --network <chain>
```

## Common Issues

### Issue: Address not found

```
[ERR_NO_CONTRACT] No FlashLoanArbitrage contract deployed for chain: ethereum.
```

**Cause**: Contract not deployed yet, or `addresses.ts` not updated after deployment

**Fix**:
1. Check `registry.json` - is address there?
2. If yes: Update `addresses.ts` manually (current process)
3. If no: Deploy contract first

### Issue: Invalid address format

```
[ERR_INVALID_ADDRESS] Invalid address format in FLASH_LOAN_CONTRACT_ADDRESSES.ethereum.
Provided: 0xGGG...zzz
Expected: 0x followed by 40 hexadecimal characters
```

**Cause**: Typo in manual address entry

**Fix**: Correct the address in `addresses.ts` (must be valid hex)

### Issue: Zero address

```
[ERR_ZERO_ADDRESS] Zero address (0x000...000) is not a valid contract address.
```

**Cause**: Undeployed or misconfigured contract

**Fix**: Deploy contract and update with real address

### Issue: Chain name alias not recognized

```
getContractAddress('zksync-mainnet'); // Works! Auto-normalizes to 'zksync'
```

**Not an issue**: All helper functions handle aliases automatically via `normalizeChainName()`

## Auto-Generation Plan (Future)

### Goal
Eliminate manual address updates by auto-generating `addresses.ts` from `registry.json`.

### Implementation

**Script**: `contracts/scripts/generate-addresses.ts`

```typescript
// Read registry.json
const registry = require('../deployments/registry.json');

// Extract addresses by contract type
const flashLoanAddresses = extractByType(registry, 'FlashLoanArbitrage');
const quoterAddresses = extractByType(registry, 'MultiPathQuoter');
// ... etc

// Generate TypeScript file
const output = `
// AUTO-GENERATED - DO NOT EDIT MANUALLY
// Generated from registry.json by scripts/generate-addresses.ts
// Last updated: ${new Date().toISOString()}

export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = ${JSON.stringify(flashLoanAddresses, null, 2)};
export const MULTI_PATH_QUOTER_ADDRESSES: Record<string, string> = ${JSON.stringify(quoterAddresses, null, 2)};
// ...
`;

fs.writeFileSync('deployments/addresses.generated.ts', output);
```

**Integration**:
```json
{
  "scripts": {
    "generate:addresses": "tsx scripts/generate-addresses.ts",
    "build": "npm run generate:addresses && tsc",
    "deploy:all": "npm run deploy && npm run generate:addresses"
  }
}
```

**Status**: 🚧 Planned (Issue 2.1, 9.1)

## Contributing

### Adding New Contract Type

1. **Create contract**: `contracts/src/MyNewContract.sol`
2. **Create deployment script**: `contracts/scripts/deploy-my-new-contract.ts`
3. **Add to registry schema**: Update `registry.json` structure
4. **Add address constant**: Add to `addresses.ts`:
   ```typescript
   export const MY_NEW_CONTRACT_ADDRESSES: Record<string, string> = {};
   ```
5. **Export**: Add to `index.ts` exports
6. **Update docs**: Add to this README
7. **Deploy & Test**: Deploy to testnet, verify addresses

### Adding New Chain

1. **Add to chain type**: Update `EVMMainnetChain` or `TestnetChain` in `addresses.ts`
2. **Add to constants**: Update `MAINNET_CHAINS` or `TESTNET_CHAINS`
3. **Add protocol addresses**: Add Aave/PancakeSwap/Balancer addresses if supported
4. **Add routers**: Add to `APPROVED_ROUTERS` if applicable
5. **Add tokens**: Add to `TOKEN_ADDRESSES` for testing
6. **Deploy**: Run deployment scripts for the new chain

## References

- [DEEP_DIVE_ANALYSIS_FINDINGS.md](./DEEP_DIVE_ANALYSIS_FINDINGS.md) - Detailed analysis of issues
- [deployment-utils.ts](../scripts/lib/deployment-utils.ts) - Shared deployment utilities
- [ARCHITECTURE_V2.md](../../docs/architecture/ARCHITECTURE_V2.md) - System architecture

---

**Last Updated**: 2026-02-10
**Status**: Active Development
**Maintainer**: Arbitrage Core Team
