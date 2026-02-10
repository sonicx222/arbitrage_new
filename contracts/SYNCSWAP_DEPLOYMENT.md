# SyncSwap Flash Loan Deployment Guide

> **Task 3.4**: SyncSwap Flash Loan Provider Implementation

## Overview

This guide covers the deployment of `SyncSwapFlashArbitrage.sol` contract on zkSync Era. SyncSwap offers **0.3% flash loan fees** with EIP-3156 standard compliance, providing the best flash loan option currently available on zkSync Era L2.

### Key Characteristics

| Feature | SyncSwap | Aave V3 | Balancer V2 |
|---------|----------|---------|-------------|
| **Flash Loan Fee** | 0.3% (30 bps) | 0.09% | 0% |
| **Architecture** | Vault-based (EIP-3156) | Pool-based | Vault-based |
| **zkSync Era** | ✅ Available | ❌ Not deployed | ❌ Not deployed |
| **Standard** | EIP-3156 compliant | Custom | Custom |
| **Discovery** | No pool discovery needed | N/A | N/A |

**Conclusion**: SyncSwap is currently the **best flash loan option for zkSync Era** despite the 0.3% fee, as Aave V3 and Balancer V2 are not yet deployed on this L2.

---

## Implementation Status

### ✅ Complete
- [x] Smart contract: `SyncSwapFlashArbitrage.sol` (710 lines)
- [x] TypeScript provider: `SyncSwapFlashLoanProvider` (310 lines)
- [x] Factory integration
- [x] Configuration setup
- [x] Deployment scripts
- [x] Interface: `ISyncSwapVault.sol` (EIP-3156)
- [x] **Code review & verification (2026-02-09)**: Confirmed contract uses `forceApprove()` pattern (USDT/BNB compatible)

### 🚀 Ready for Deployment
- [ ] zkSync Era Mainnet - Pending deployment
- [ ] zkSync Era Testnet (Sepolia) - Pending deployment

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

# zkSync Era RPC URLs
ZKSYNC_RPC_URL=https://mainnet.era.zksync.io
ZKSYNC_TESTNET_RPC_URL=https://sepolia.era.zksync.dev

# Block explorer API keys (for verification)
ZKSYNC_ETHERSCAN_API_KEY=your_zksync_explorer_key
```

### 3. Fund Deployment Wallet

Ensure your deployment wallet has sufficient ETH on zkSync Era:

| Network | Estimated Gas | How to Fund |
|---------|---------------|-------------|
| zkSync Era Mainnet | ~0.001 ETH | Bridge from Ethereum: https://portal.zksync.io/bridge/ |
| zkSync Era Sepolia | ~0.001 ETH | Bridge from Sepolia: https://portal.zksync.io/bridge/?network=sepolia |

**Note**: zkSync Era uses significantly less gas than Ethereum L1 due to L2 optimizations.

---

## Deployment Process

### Phase 1: Testnet Deployment (Recommended)

Test on zkSync Era Sepolia testnet before mainnet deployment:

```bash
# Deploy to zkSync Era Sepolia Testnet
npx hardhat run scripts/deploy-syncswap.ts --network zksync-testnet

# Expected output:
# ✅ Contract deployed at: 0x...
# ✅ Minimum profit set
# ✅ Routers approved (2)
# ✅ Contract verified
```

**Testnet Addresses**:
- **Vault**: `0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8` (Staging Testnet)
- **Router**: `0xB3b7fCbb8Db37bC6f572634299A58f51622A847e` (SyncSwap Router)
- **Explorer**: https://sepolia.explorer.zksync.io/

### Phase 2: Mainnet Deployment

Deploy to production zkSync Era mainnet:

```bash
# Deploy to zkSync Era Mainnet
npx hardhat run scripts/deploy-syncswap.ts --network zksync-mainnet

# Expected output:
# ✅ Contract deployed at: 0x...
# ✅ Minimum profit set
# ✅ Routers approved (3)
# ✅ Contract verified
```

**Mainnet Addresses**:
- **Vault**: `0x621425a1Ef6abE91058E9712575dcc4258F8d091`
- **Router**: `0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295` (SyncSwap Router)
- **Explorer**: https://explorer.zksync.io/

### Phase 3: Configuration Update

After deployment, update configuration files:

#### 1. Update `.env` (root directory)

```env
# Add to your .env file
ZKSYNC_FLASH_LOAN_CONTRACT=0x<deployed_contract_address>
ZKSYNC_APPROVED_ROUTERS=0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295,0x8B791913eB07C32779a16750e3868aA8495F5964
```

#### 2. Update Execution Engine Config (if using hardcoded addresses)

```typescript
// In execution engine initialization
const flashLoanStrategyConfig = {
  contractAddresses: {
    // ... existing chains
    zksync: '0x<deployed_contract_address>',
  },
  approvedRouters: {
    // ... existing chains
    zksync: [
      '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295', // SyncSwap Router
      '0x8B791913eB07C32779a16750e3868aA8495F5964', // Mute.io
      '0x39E098A153Ad69834a9Dac32f0FCa92066aD03f4', // Velocore
    ],
  },
};
```

### Phase 4: Service Restart & Testing

```bash
# Restart execution engine
npm run dev:execution:fast

# Expected log output:
# "Created SyncSwap provider for zksync"
# "Flash loan provider available: syncswap (zksync)"

# Run integration tests (if available)
npm run test:integration -- syncswap

# Monitor metrics
# Check for successful flash loan executions on zkSync Era
```

---

## Verification

### Manual Contract Verification

If automatic verification fails during deployment:

```bash
npx hardhat verify --network zksync-mainnet \
  <contract_address> \
  0x621425a1Ef6abE91058E9712575dcc4258F8d091 \
  <owner_address>
```

Example for zkSync Era mainnet:

```bash
npx hardhat verify --network zksync-mainnet \
  0xYourContractAddress \
  0x621425a1Ef6abE91058E9712575dcc4258F8d091 \
  0xYourOwnerAddress
```

### Deployment Verification Checklist

- [ ] Contract deployed successfully
- [ ] Contract verified on zkSync Era explorer
- [ ] Minimum profit threshold set
- [ ] DEX routers approved (3+ on mainnet, 2+ on testnet)
- [ ] Deployment saved to registry (`deployments/syncswap-registry.json`)
- [ ] Configuration updated in `.env`
- [ ] Services restarted with new config
- [ ] Provider loads correctly in factory
- [ ] Test arbitrage executed successfully (optional)

---

## Configuration Reference

### Vault Addresses

```typescript
const SYNCSWAP_VAULTS = {
  // zkSync Era Mainnet
  'zksync-mainnet': '0x621425a1Ef6abE91058E9712575dcc4258F8d091',
  'zksync': '0x621425a1Ef6abE91058E9712575dcc4258F8d091',

  // zkSync Era Sepolia Testnet
  'zksync-testnet': '0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8',
  'zksync-sepolia': '0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8',
};
```

### Default Approved Routers

**Mainnet**:
- SyncSwap Router: `0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295`
- Mute.io Router: `0x8B791913eB07C32779a16750e3868aA8495F5964`
- Velocore Router: `0x39E098A153Ad69834a9Dac32f0FCa92066aD03f4`

**Testnet**:
- SyncSwap Router: `0xB3b7fCbb8Db37bC6f572634299A58f51622A847e`

---

## Troubleshooting

### Deployment Fails: "Insufficient Funds"

**Solution**: Fund your deployment wallet with ETH on zkSync Era.

```bash
# Check deployer balance on zkSync Era
npx hardhat run scripts/check-balance.ts --network zksync-mainnet
```

Bridge ETH from Ethereum L1 to zkSync Era L2: https://portal.zksync.io/bridge/

### Verification Fails: "Already Verified"

**Solution**: Contract is already verified. This is fine, continue to next step.

### Verification Fails: Other Errors

**Solution**: Verify manually using the command shown in the deployment output.

```bash
npx hardhat verify --network zksync-mainnet \
  <contract_address> \
  <vault_address> \
  <owner_address>
```

### Router Approval Fails

**Solution**: Check router address is correct for the network. See "Default Approved Routers" section above.

### Gas Estimation Too High

**Solution**: zkSync Era has different gas model than Ethereum. Default estimates (~600k gas) are conservative and should work. Actual gas usage is typically 400k-500k.

---

## Post-Deployment Monitoring

### Key Metrics to Track

1. **Flash Loan Success Rate**
   - Target: >90%
   - Monitor via execution engine logs

2. **Cost vs Other Protocols**
   - SyncSwap: 0.3% fee
   - Track cumulative fee costs over time
   - Compare to Aave V3 (0.09%) on other chains

3. **Gas Costs**
   - zkSync Era uses L2 gas pricing (much cheaper than L1)
   - Benchmark actual gas costs per trade
   - Typical: 400k-500k gas units

4. **Execution Latency**
   - Target: <2s for flash loan execution
   - zkSync Era L2 has faster block times (~1s)

### Monitoring Commands

```bash
# Check execution engine logs
npm run dev:execution:fast

# Filter for SyncSwap provider
# Look for: "SyncSwap flash loan executed successfully"

# Check deployed contract on explorer
# Mainnet: https://explorer.zksync.io/address/<contract_address>
# Testnet: https://sepolia.explorer.zksync.io/address/<contract_address>
```

---

## Rollback Plan

If issues arise after deployment:

### Option 1: Pause Contract

```bash
# Pause the contract (stops all arbitrage)
npx hardhat run scripts/toggle-syncswap-pause.ts pause --network zksync-mainnet

# When ready to resume
npx hardhat run scripts/toggle-syncswap-pause.ts unpause --network zksync-mainnet
```

This stops all flash loan execution while you investigate issues.

### Option 2: Disable in Configuration

Comment out zkSync Era in `FLASH_LOAN_PROVIDERS`:

```typescript
// In service-config.ts
export const FLASH_LOAN_PROVIDERS = {
  // ... other chains

  // Temporarily disabled - investigating issues
  // zksync: {
  //   address: SYNCSWAP_VAULTS.zksync,
  //   protocol: 'syncswap',
  //   fee: 30
  // },
};
```

Restart services. System will skip zkSync Era opportunities.

---

## Cost Analysis

### Example: $10,000 Flash Loan

| Protocol | Fee | Cost | Availability on zkSync Era |
|----------|-----|------|----------------------------|
| SyncSwap | 0.3% | $30 | ✅ Available |
| Aave V3 | 0.09% | $9 | ❌ Not deployed |
| Balancer V2 | 0% | $0 | ❌ Not deployed |

**Conclusion**: While SyncSwap's 0.3% fee is higher than alternatives, it's currently the only viable option for flash loans on zkSync Era.

**Annual Impact** (assuming 1000 trades of $10k each):
- SyncSwap fee cost: 1000 × $30 = **$30,000/year**
- This is acceptable given zkSync Era's lower gas costs offset the higher flash loan fee

---

## Network Comparison

### zkSync Era Advantages
- **Lower Gas Costs**: L2 optimization reduces gas by ~90% vs Ethereum L1
- **Faster Blocks**: ~1s block time (vs 12s on Ethereum)
- **Growing Ecosystem**: Active DEX development (SyncSwap, Mute, Velocore)

### Trade-offs
- **Higher Flash Loan Fee**: 0.3% vs 0.09% (Aave) or 0% (Balancer) on other chains
- **Smaller TVL**: Less liquidity than Ethereum L1
- **Newer Network**: Less battle-tested than Ethereum mainnet

**Verdict**: zkSync Era is viable for arbitrage despite higher flash loan fees, thanks to significantly lower gas costs.

---

## References

- [SyncSwap Documentation](https://syncswap.xyz/)
- [SyncSwap API Documentation](../docs/syncswap_api_dpcu.md)
- [Flash Loan Implementation Plan](../docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md) - Task 3.4
- [SyncSwapFlashArbitrage.sol](./src/SyncSwapFlashArbitrage.sol)
- [Deployment Script](./scripts/deploy-syncswap.ts)
- [zkSync Era Block Explorer](https://explorer.zksync.io/)
- [zkSync Era Bridge](https://portal.zksync.io/bridge/)

---

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review implementation plan document
3. Check deployment logs in `deployments/` directory
4. Verify contract on zkSync Era explorer
5. Check execution engine logs for provider initialization

---

**Last Updated**: 2026-02-09
**Status**: Ready for Deployment
**Task**: 3.4 - SyncSwap Flash Loan Provider (zkSync Era)
**Implementation**: Complete - Ready for testnet/mainnet deployment
