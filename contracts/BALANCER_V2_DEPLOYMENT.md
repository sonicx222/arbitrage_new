# Balancer V2 Flash Loan Deployment Guide

> **Task 2.2**: Balancer V2 Flash Loan Provider Implementation

## Overview

This guide covers the deployment of `BalancerV2FlashArbitrage.sol` contracts across 6 chains. Balancer V2 offers **0% flash loan fees** (vs Aave V3's 0.09%), providing immediate cost savings on every arbitrage trade.

### Key Advantages

| Feature | Balancer V2 | Aave V3 |
|---------|-------------|---------|
| **Flash Loan Fee** | 0% | 0.09% |
| **Architecture** | Single Vault per chain | Pool-based |
| **Discovery** | No pool discovery needed | N/A |
| **Liquidity** | All Balancer pools | Pool-specific |
| **Savings** | $90 per $100K loan | - |

---

## Implementation Status

### ✅ Complete
- [x] Smart contract: `BalancerV2FlashArbitrage.sol` (574 lines)
- [x] TypeScript provider: `BalancerV2FlashLoanProvider` (302 lines)
- [x] Factory integration
- [x] Configuration setup
- [x] Deployment scripts

### 🚀 Ready for Deployment
- [x] Fantom (Beethoven X) - **ACTIVE**
- [ ] Ethereum - Pending deployment
- [ ] Polygon - Pending deployment
- [ ] Arbitrum - Pending deployment
- [ ] Optimism - Pending deployment
- [ ] Base - Pending deployment

---

## Prerequisites

### 1. Environment Setup

```bash
# Install dependencies
npm install

# Build contracts
cd contracts
npx hardhat compile
```

### 2. Environment Variables

Create a `.env` file in the `contracts/` directory:

```env
# Deployment wallet
DEPLOYER_PRIVATE_KEY=your_private_key_here

# Block explorer API keys (for verification)
ETHERSCAN_API_KEY=your_etherscan_key
POLYGONSCAN_API_KEY=your_polygonscan_key
ARBISCAN_API_KEY=your_arbiscan_key
OPTIMISTIC_ETHERSCAN_API_KEY=your_optimism_key
BASESCAN_API_KEY=your_basescan_key
FTMSCAN_API_KEY=your_ftmscan_key

# RPC URLs (optional, can use Hardhat defaults)
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/your-key
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/your-key
OPTIMISM_RPC_URL=https://opt-mainnet.g.alchemy.com/v2/your-key
BASE_RPC_URL=https://mainnet.base.org
FANTOM_RPC_URL=https://rpc.ftm.tools/
```

### 3. Fund Deployment Wallet

Ensure your deployment wallet has sufficient native tokens:

| Chain | Estimated Gas | Native Token |
|-------|---------------|--------------|
| Ethereum | ~0.01 ETH | ETH |
| Polygon | ~0.1 MATIC | MATIC |
| Arbitrum | ~0.001 ETH | ETH |
| Optimism | ~0.001 ETH | ETH |
| Base | ~0.001 ETH | ETH |
| Fantom | ~10 FTM | FTM |

---

## Deployment Process

### Phase 1: Testnet Deployment (Recommended)

Test on testnets before mainnet deployment:

```bash
# Sepolia (Ethereum testnet)
npx hardhat run scripts/deploy-balancer.ts --network sepolia

# Mumbai (Polygon testnet)
npx hardhat run scripts/deploy-balancer.ts --network mumbai

# Arbitrum Goerli
npx hardhat run scripts/deploy-balancer.ts --network arbitrumGoerli
```

Verify the deployment works correctly:
1. Check contract is deployed and verified
2. Test router approval
3. Execute a small test arbitrage

### Phase 2: Mainnet Deployment

Deploy to production networks in priority order:

#### Step 1: Ethereum (Highest Value)

```bash
# Deploy to Ethereum mainnet
npx hardhat run scripts/deploy-balancer.ts --network ethereum

# Expected output:
# ✅ Contract deployed at: 0x...
# ✅ Minimum profit set
# ✅ Routers approved (3)
# ✅ Contract verified
```

#### Step 2: Polygon (High Volume)

```bash
npx hardhat run scripts/deploy-balancer.ts --network polygon
```

#### Step 3: Arbitrum (Low Gas)

```bash
npx hardhat run scripts/deploy-balancer.ts --network arbitrum
```

#### Step 4: Optimism (Growing TVL)

```bash
npx hardhat run scripts/deploy-balancer.ts --network optimism
```

#### Step 5: Base (Emerging)

```bash
npx hardhat run scripts/deploy-balancer.ts --network base
```

### Phase 3: Configuration Update

After deployment, update configuration files:

```bash
# Generate configuration snippets
npx ts-node scripts/update-balancer-config.ts
```

This will print configuration updates for:
1. `shared/config/src/service-config.ts` - FLASH_LOAN_PROVIDERS
2. Execution engine initialization - contractAddresses
3. `.env` file - optional environment variables

**Copy-paste the generated configuration** into the respective files.

### Phase 4: Service Restart & Testing

```bash
# Restart execution engine
npm run dev:execution:fast

# Run integration tests
npm run test:integration -- balancer

# Monitor metrics
# Check Grafana dashboard for flash loan success rate
```

---

## Verification

### Manual Contract Verification

If automatic verification fails during deployment:

```bash
npx hardhat verify --network <network> \
  <contract_address> \
  <vault_address> \
  <owner_address>
```

Example for Ethereum:

```bash
npx hardhat verify --network ethereum \
  0xYourContractAddress \
  0xBA12222222228d8Ba445958a75a0704d566BF2C8 \
  0xYourOwnerAddress
```

### Deployment Verification Checklist

- [ ] Contract deployed successfully
- [ ] Contract verified on block explorer
- [ ] Minimum profit threshold set
- [ ] DEX routers approved (3+ per chain)
- [ ] Deployment saved to registry (`deployments/balancer-registry.json`)
- [ ] Configuration updated in `service-config.ts`
- [ ] Services restarted with new config
- [ ] Integration tests passing
- [ ] Test arbitrage executed successfully

---

## Configuration Reference

### Vault Addresses (Canonical)

```typescript
const BALANCER_V2_VAULTS = {
  ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  polygon: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  optimism: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  base: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  fantom: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce', // Beethoven X
};
```

### Default Approved Routers

See `scripts/deploy-balancer.ts` for the full list of default routers per chain.

---

## Troubleshooting

### Deployment Fails: "Insufficient Funds"

**Solution**: Fund your deployment wallet with more native tokens.

```bash
# Check deployer balance
npx hardhat run scripts/check-balance.ts --network <network>
```

### Verification Fails: "Already Verified"

**Solution**: Contract is already verified. This is fine, continue to next step.

### Verification Fails: Other Errors

**Solution**: Verify manually using the command shown in the deployment output.

### Router Approval Fails

**Solution**: Check router address is correct for the chain. See `DEFAULT_APPROVED_ROUTERS` in `deploy-balancer.ts`.

### Gas Estimation Too High

**Solution**: Ensure you're deploying to the correct network. Ethereum mainnet has high gas costs (~$20-50 for deployment).

---

## Post-Deployment Monitoring

### Key Metrics to Track

1. **Flash Loan Success Rate**
   - Target: >95%
   - Monitor via Grafana dashboard

2. **Cost Savings vs Aave V3**
   - Compare fee expenses: Balancer (0%) vs Aave (0.09%)
   - Track cumulative savings over time

3. **Gas Costs**
   - Balancer V2 Vault may have different gas profile than Aave V3
   - Benchmark and document gas costs per chain

4. **Execution Latency**
   - No pool discovery = potentially faster execution
   - Compare latency vs Aave V3

---

## Rollback Plan

If issues arise after deployment:

### Option 1: Revert to Aave V3

1. In `service-config.ts`, comment out Balancer V2 entries
2. Uncomment Aave V3 entries
3. Restart services
4. Verify flash loans working with Aave V3

### Option 2: Emergency Pause

```bash
# Pause the Balancer V2 contract
npx hardhat run scripts/pause-balancer.ts --network <network>
```

This stops all arbitrage execution while you investigate issues.

---

## Cost Analysis

### Example: $100,000 Flash Loan

| Protocol | Fee | Cost | Savings |
|----------|-----|------|---------|
| Balancer V2 | 0% | $0 | - |
| Aave V3 | 0.09% | $90 | -$90 |

**Annual Savings** (assuming 1000 trades):
- 1000 trades × $90 savings = **$90,000 saved**

---

## References

- [Balancer V2 Documentation](https://docs.balancer.fi/)
- [Flash Loan Implementation Plan](../docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md) - Task 2.2
- [BalancerV2FlashArbitrage.sol](./src/BalancerV2FlashArbitrage.sol)
- [Deployment Script](./scripts/deploy-balancer.ts)

---

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review implementation plan document
3. Check deployment logs in `deployments/` directory
4. Open an issue in the project repository

---

**Last Updated**: 2026-02-09
**Status**: Ready for Production Deployment
**Task**: 2.2 - Balancer V2 Flash Loan Provider
