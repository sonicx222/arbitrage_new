# Post-Deployment Verification Checklist

> **Last Updated:** 2026-02-25
> **Purpose:** End-to-end validation after deploying contracts to any chain
> **When to use:** After every deployment (testnet or mainnet)

---

## Quick Checklist

Copy this checklist for each deployment:

```
Chain: _______________
Date:  _______________

[ ] 1. Contract verified on block explorer
[ ] 2. Owner address correct
[ ] 3. Minimum profit threshold set (non-zero on mainnet)
[ ] 4. Approved routers configured
[ ] 5. Pause/unpause works
[ ] 6. Registry and addresses updated
[ ] 7. Service configuration updated
[ ] 8. TypeScript compilation passes
[ ] 9. Services restarted and detecting opportunities
[ ] 10. Monitoring confirms contract is operational
```

---

## Detailed Steps

### 1. Verify Contract on Block Explorer

```bash
cd contracts

# Check verification status in registry
cat deployments/registry.json | jq '.<network>.<ContractType>_verified'

# If false, verify manually (see contract-verification-guide.md)
npx hardhat verify --network <chain> <address> <constructor-args...>
```

Confirm on the block explorer that the "Contract" tab shows source code, not just bytecode.

### 2. Verify Owner Address

```bash
npx hardhat console --network <chain>

# Check owner matches deployer (or intended owner)
> const contract = await ethers.getContractAt('<ContractType>', '<address>')
> await contract.owner()
# Should return deployer address

# Check no pending ownership transfer
> await contract.pendingOwner()
# Should return 0x0000000000000000000000000000000000000000
```

### 3. Verify Minimum Profit Threshold

```bash
> const minProfit = await contract.minimumProfit()
> console.log('Min profit:', ethers.formatEther(minProfit), 'ETH')
```

| Network Type | Expected Range | Red Flag |
|-------------|---------------|----------|
| Testnet | Any value (0 allowed) | — |
| Mainnet | >= 0.0001 ETH (1e14 wei) | 0 or extremely low values |

The deployment pipeline sets this automatically based on the chain's flash loan protocol. If incorrect:

```bash
> await contract.setMinimumProfit(ethers.parseEther('0.001'))
```

### 4. Verify Approved Routers

```bash
# List all approved routers
> const routers = await contract.getApprovedRouters()
> console.log('Approved routers:', routers.length)
> for (const r of routers) console.log(' ', r)
```

Cross-reference with `APPROVED_ROUTERS` in `contracts/deployments/addresses.ts`. Every router listed for this chain should be approved on-chain.

```bash
# Or use the validation script
npm run validate:routers
```

### 5. Verify Pause/Unpause

```bash
# Check current state
> await contract.paused()
# Should return false

# Test pause (only do on testnets, or immediately unpause on mainnet)
> await contract.pause()
> await contract.paused()  // true
> await contract.unpause()
> await contract.paused()  // false
```

### 6. Update Registry and Address Files

```bash
# Verify registry was updated by the deploy script
cat contracts/deployments/registry.json | jq '.<network>'

# Regenerate address constants
npm run generate:addresses

# Update FLASH_LOAN_CONTRACT_ADDRESSES if needed
# Edit contracts/deployments/addresses.ts
```

### 7. Update Service Configuration

Update these files when deploying to a new chain:

| File | What to Update |
|------|---------------|
| `shared/config/src/service-config.ts` | Uncomment flash loan provider for the chain |
| `shared/config/src/service-config.ts` | Set `multiPathQuoterAddress` for the chain |
| `contracts/deployments/addresses.ts` | Add to `FLASH_LOAN_CONTRACT_ADDRESSES` |
| `contracts/deployments/addresses.ts` | Add V3Adapter to `APPROVED_ROUTERS` (if deployed) |

### 8. TypeScript Compilation

```bash
npm run typecheck
```

Must pass with zero errors. If there are type errors related to new addresses, fix them before proceeding.

### 9. Restart Services

```bash
# Development
npm run dev:stop && npm run dev:all

# Production (Fly.io)
fly deploy --app <service-name>
```

### 10. Monitoring Validation

After restarting services, verify within the first hour:

| Check | How | Expected |
|-------|-----|----------|
| Chain appears in coordinator | Check coordinator dashboard `/health` | Chain listed in active partitions |
| Price feeds arriving | Check Redis streams | `prices:{chain}` stream has recent entries |
| Opportunities detected | Check coordinator logs | At least 1 opportunity within 30 minutes (depends on market) |
| Execution engine aware | Check execution engine `/health` | New contract address in config |

```bash
# Quick health check
curl http://localhost:3000/health | jq '.partitions'
curl http://localhost:3005/health | jq '.contracts'
```

---

## Contract-Specific Checks

### FlashLoanArbitrage (Aave V3)

```bash
> const pool = await contract.POOL()  # or equivalent getter
# Should match AAVE_V3_POOLS[chain]
```

### BalancerV2FlashArbitrage

```bash
> const vault = await contract.vault()
# Should match BALANCER_V2_VAULTS[chain]
```

### PancakeSwapFlashArbitrage

```bash
> const factory = await contract.factory()
# Should match PANCAKESWAP_V3_FACTORIES[chain]
```

### SyncSwapFlashArbitrage (zkSync)

```bash
> const vault = await contract.vault()
# Should match SYNCSWAP_VAULTS[chain]
```

### CommitRevealArbitrage

```bash
# Verify commit-reveal parameters
> await contract.maxCommitAgeBlocks()     # Max blocks for commitment validity (configurable, default 10)
> await contract.MIN_DELAY_BLOCKS()       # Minimum blocks between commit and reveal (constant = 1)
> await contract.DEFAULT_MAX_COMMIT_AGE() # Default max commit age (constant = 10)
> await contract.MIN_COMMIT_AGE()         # Minimum allowed maxCommitAgeBlocks (constant = 5)
> await contract.MAX_COMMIT_AGE()         # Maximum allowed maxCommitAgeBlocks (constant = 100)
```

Check feature flags are enabled in the environment:
```bash
FEATURE_COMMIT_REVEAL=true
FEATURE_COMMIT_REVEAL_REDIS=true  # Optional: Redis-backed commit storage
```

### MultiPathQuoter

```bash
# Test with a batch quote call (view function, no gas cost)
> const quoter = await ethers.getContractAt('MultiPathQuoter', '<address>')
> await quoter.getBatchedQuotes([])  # Empty array returns empty
```

Check feature flag: `FEATURE_BATCHED_QUOTER=true`

### UniswapV3Adapter

```bash
> const router = await adapter.v3Router()
# Should match the V3 SwapRouter for this chain

> const fee = await adapter.defaultFee()
# Should be 3000 (0.3%)
```

Verify the adapter is registered as an approved router on the FlashLoanArbitrage contract:

```bash
> const flashLoan = await ethers.getContractAt('FlashLoanArbitrage', '<flashloan-address>')
> await flashLoan.isApprovedRouter('<adapter-address>')
# Should return true
```
