# Contract Deployment Workflow

**Document Version**: 1.0.0
**Last Updated**: 2026-02-10
**Status**: Production

---

## Overview

This document describes the **actual** deployment workflow for flash loan arbitrage contracts. Deployment scripts **do not auto-update TypeScript configuration files** - manual steps are required.

---

## Prerequisites

1. **Environment Setup**:
   ```bash
   cd contracts
   npm install
   ```

2. **Configure Environment Variables**:
   ```bash
   cp ../.env.example ../.env.local
   # Edit .env.local with:
   # - DEPLOYER_PRIVATE_KEY
   # - RPC URLs
   # - Block explorer API keys (ETHERSCAN_API_KEY, etc.)
   ```

3. **Fund Deployer Wallet**:
   - Testnet: Get faucet funds
   - Mainnet: Ensure sufficient native token for gas

4. **Pre-Deployment Checklist**:
   - [ ] Contract compiled: `npm run build`
   - [ ] Tests passing: `npm test`
   - [ ] Deployer wallet funded
   - [ ] RPC endpoint configured and working
   - [ ] Block explorer API key configured (for verification)

---

## Gas Cost Estimates

**P2-001 FIX**: Estimated deployment costs to help with wallet funding.

Use these estimates to fund your deployer wallet. Actual costs vary with network gas prices.

### Contract Deployment Costs

| Contract | Ethereum | Arbitrum | BSC | Polygon | Base | Optimism |
|----------|----------|----------|-----|---------|------|----------|
| **FlashLoanArbitrage** (Aave V3) | ~0.015 ETH | ~0.001 ETH | ~0.005 BNB | ~15 MATIC | ~0.001 ETH | ~0.001 ETH |
| **BalancerV2FlashArbitrage** | ~0.018 ETH | ~0.0012 ETH | ~0.006 BNB | ~18 MATIC | ~0.0012 ETH | ~0.0012 ETH |
| **PancakeSwapFlashArbitrage** | ~0.020 ETH | ~0.0015 ETH | ~0.007 BNB | ~20 MATIC | ~0.0015 ETH | ~0.0015 ETH |
| **SyncSwapFlashArbitrage** (zkSync) | N/A | N/A | N/A | N/A | N/A | N/A |
| **CommitRevealArbitrage** | ~0.012 ETH | ~0.0008 ETH | ~0.004 BNB | ~12 MATIC | ~0.0008 ETH | ~0.0008 ETH |
| **MultiPathQuoter** | ~0.008 ETH | ~0.0005 ETH | ~0.003 BNB | ~8 MATIC | ~0.0005 ETH | ~0.0005 ETH |

**Notes**:
- Costs include: deployment + configuration (setMinimumProfit + router approvals)
- Router approvals scale with number of routers (~0.001 ETH per router on Ethereum)
- Estimates assume moderate gas prices (30 gwei Ethereum, 0.1 gwei Arbitrum)
- **zkSync Era**: SyncSwap deployment costs ~0.005 ETH (L2 gas model differs)
- **Testnet**: Same gas limits, but free/cheap test tokens

### Real-Time Gas Estimation

For accurate pre-deployment estimates, use:
```bash
# Check current gas prices and estimate deployment cost
npx hardhat run scripts/check-balance.ts --network {network}
```

This script:
- Shows current gas price on the network
- Estimates deployment cost at current prices
- Warns if balance is insufficient

### Funding Recommendations

**Testnet**:
- Faucet: Get free test tokens (links in `/docs/local-development.md`)
- Recommended: 0.1 ETH equivalent (enough for multiple deployments + testing)

**Mainnet**:
- Recommended: 2x estimated cost (buffer for gas price spikes)
- Example: For Ethereum FlashLoanArbitrage (~0.015 ETH), fund with 0.03 ETH
- Monitor gas prices: Use tools like Etherscan Gas Tracker or blocknative.com
- Deploy during low-traffic periods (weekends, off-peak hours) to save 30-50%

### Cost Breakdown Example (Ethereum FlashLoanArbitrage)

| Operation | Gas Limit | Gas Cost @ 30 gwei | USD @ $3000/ETH |
|-----------|-----------|-------------------|------------------|
| Contract Deployment | ~400,000 | ~0.012 ETH | ~$36 |
| setMinimumProfit() | ~50,000 | ~0.0015 ETH | ~$4.50 |
| approveRouter() × 2 | ~100,000 | ~0.003 ETH | ~$9 |
| **Total** | **~550,000** | **~0.0165 ETH** | **~$49.50** |

**Cost Savings**:
- Balancer V2 has 0% flash loan fees (saves 0.09% per trade vs Aave V3)
- On a $100K flash loan: Save $90 per trade
- Break-even: ~550 trades to recover higher deployment cost

---

## Deployment Process

### Step 1: Run Deployment Script

**Testnet** (recommended first):
```bash
# Sepolia
npx hardhat run scripts/deploy.ts --network sepolia

# Arbitrum Sepolia
npx hardhat run scripts/deploy.ts --network arbitrumSepolia
```

**Mainnet** (after testnet validation + security audit):
```bash
# Ethereum
npx hardhat run scripts/deploy.ts --network ethereum

# Arbitrum
npx hardhat run scripts/deploy.ts --network arbitrum
```

### Step 2: Verify Script Output

Deployment script outputs:
```
========================================
Deployment Summary
========================================
Network:          sepolia (chainId: 11155111)
Contract:         0x1234567890123456789012345678901234567890
Owner:            0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
Deployer:         0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
Transaction:      0x9876543210987654321098765432109876543210987654321098765432109876
Block:            12345678
Timestamp:        2026-02-10T12:00:00.000Z
Minimum Profit:   0.001 ETH
Approved Routers: 1
Verified:         ✅ Yes
========================================

📋 NEXT STEPS:

1. Update contract address in configuration:
   File: contracts/deployments/addresses.ts
   Update: FLASH_LOAN_CONTRACT_ADDRESSES.sepolia = '0x1234567890123456789012345678901234567890';

2. Restart services to pick up new configuration
```

**What the script does**:
- ✅ Compiles and deploys contract
- ✅ Configures minimum profit threshold
- ✅ Approves DEX routers
- ✅ Verifies on block explorer
- ✅ Runs smoke tests
- ✅ Saves to `deployments/registry.json`
- ✅ Saves to `deployments/{network}.json`

**What the script does NOT do**:
- ❌ Does NOT update `deployments/addresses.ts` (TypeScript file)
- ❌ Does NOT update service configuration files
- ❌ Does NOT restart running services

### Step 3: Manual Update - addresses.ts

**REQUIRED**: Manually update the TypeScript constants file.

1. **Open** `contracts/deployments/addresses.ts`

2. **Locate** the relevant constant (e.g., `FLASH_LOAN_CONTRACT_ADDRESSES`)

3. **Uncomment and update** with deployed address:
   ```typescript
   export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = {
     // Before:
     // sepolia: '0x...', // TODO: Deploy and update

     // After:
     sepolia: '0x1234567890123456789012345678901234567890', // Deployed 2026-02-10
   };
   ```

4. **Verify** address matches deployment script output exactly (copy-paste to avoid typos)

5. **Add comment** with deployment date for audit trail

### Step 4: Verify Configuration

Run validation script to ensure registry.json and addresses.ts are in sync:

```bash
npm run validate:addresses
```

Expected output:
```
✅ VALIDATION PASSED: All addresses are synchronized!
```

If validation fails, review and correct addresses in addresses.ts.

### Step 5: Commit Changes

```bash
git add contracts/deployments/addresses.ts
git add contracts/deployments/registry.json
git add contracts/deployments/{network}.json
git commit -m "deploy: add FlashLoanArbitrage contract on {network}

Contract: 0x1234567890123456789012345678901234567890
Network: {network} (chainId: {chainId})
Verified: {yes/no}
"
git push
```

### Step 6: Update Service Configuration

If services are running and need to use the new contract:

1. **Pull latest code** (with updated addresses.ts):
   ```bash
   cd /path/to/arbitrage_new
   git pull
   ```

2. **Rebuild services** that import contract addresses:
   ```bash
   npm run build:deps  # Rebuild shared packages
   npm run build       # Rebuild services
   ```

3. **Restart services**:
   ```bash
   npm run dev:stop      # Stop running services
   npm run dev:all       # Restart with new config
   ```

---

## Protocol-Specific Deployments

Each contract type uses a different deployment script:

### Aave V3 Flash Loan (FlashLoanArbitrage)
```bash
npx hardhat run scripts/deploy.ts --network {network}
```
Updates: `FLASH_LOAN_CONTRACT_ADDRESSES`

### Balancer V2 Flash Loan
```bash
npx hardhat run scripts/deploy-balancer.ts --network {network}
```
Updates: `BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES`
Registry: `deployments/balancer-registry.json`

### PancakeSwap V3 Flash Loan
```bash
npx hardhat run scripts/deploy-pancakeswap.ts --network {network}
```
Updates: `PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES`
Registry: `deployments/pancakeswap-registry.json`

### SyncSwap Flash Loan (zkSync Era)
```bash
npx hardhat run scripts/deploy-syncswap.ts --network {network}
```
Updates: `SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES`
Registry: `deployments/syncswap-registry.json`

### Commit-Reveal MEV Protection
```bash
npx hardhat run scripts/deploy-commit-reveal.ts --network {network}
```
Updates: `COMMIT_REVEAL_ARBITRAGE_ADDRESSES`
Registry: `deployments/commit-reveal-registry.json`

### MultiPathQuoter
```bash
npx hardhat run scripts/deploy-multi-path-quoter.ts --network {network}
```
Updates: `MULTI_PATH_QUOTER_ADDRESSES`
Registry: `deployments/multi-path-quoter-registry.json`

---

## Troubleshooting

### Deployment Fails with "Insufficient Funds"
- Check deployer wallet balance: `npx hardhat run scripts/check-balance.ts --network {network}`
- Fund wallet with native token for gas

### Deployment Fails with "Nonce Too Low"
- Another transaction from this wallet is pending
- Wait for pending transaction to confirm
- Or use `--reset` flag (dangerous - only if you know what you're doing)

### Verification Fails
- Block explorer may not have indexed yet (wait 1-2 minutes)
- API key may be incorrect
- Manual verification:
  ```bash
  npx hardhat verify --network {network} {contractAddress} {constructorArg1} {constructorArg2}
  ```

### Registry File Locked
- Another deployment is in progress (wait for it to complete)
- Stale lock (wait 30s, lock will expire)
- Manual unlock: Delete `deployments/registry.json.lock` if deployment crashed

### Address Validation Fails
- Mismatch between registry.json and addresses.ts
- Review deployment script output and correct addresses.ts
- Ensure you copied the full address (0x + 40 hex chars)

---

## Mainnet Deployment Checklist

Before deploying to mainnet:

**Security**:
- [ ] Contract security audit completed
- [ ] Audit findings addressed
- [ ] Code freeze after audit (no changes)

**Testing**:
- [ ] Deployed and tested on testnet
- [ ] Integration tests passing
- [ ] Manual testing completed
- [ ] Smoke tests passing on testnet deployment

**Configuration**:
- [ ] Minimum profit threshold set appropriately (not 0)
- [ ] Only trusted routers approved
- [ ] Owner address is multisig (not EOA)
- [ ] Gas price acceptable (check current network conditions)

**Preparation**:
- [ ] Deployer wallet funded with sufficient gas
- [ ] RPC endpoint reliable and rate-limited appropriately
- [ ] Block explorer API key configured
- [ ] Team notified of deployment
- [ ] Monitoring/alerts configured

**Post-Deployment**:
- [ ] Verification successful on block explorer
- [ ] Smoke tests passing
- [ ] addresses.ts updated
- [ ] Configuration validated
- [ ] Changes committed and pushed
- [ ] Services restarted with new configuration
- [ ] Monitoring confirms contract is functional

---

## Future Improvements

**Auto-Generation** (TODO):
- Generate `addresses.ts` from `registry.json` at build time
- Eliminate manual copy-paste step
- Reduce deployment errors

**Unified Registry** (TODO):
- Consolidate 6 separate registry files into one
- Single source of truth for all contract deployments
- Atomic updates (all contracts for a network updated together)

**Deployment Dashboard** (TODO):
- Web UI showing deployed contracts across all networks
- Compare registry.json vs. addresses.ts automatically
- One-click configuration updates

---

## Related Documentation

- **Deep Dive Analysis**: `contracts/deployments/DEEP_DIVE_ANALYSIS_REPORT.md`
- **Pre-Deployment Checklist**: `contracts/scripts/PRE_DEPLOYMENT_CHECKLIST.md`
- **Contract ABIs**: `shared/config/src/service-config.ts`
- **Network Configuration**: `contracts/deployments/addresses.ts`

---

**Questions?** See `docs/local-development.md` or ask in team chat.
