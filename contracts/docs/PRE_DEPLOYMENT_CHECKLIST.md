# Pre-Deployment Checklist

**Purpose**: Ensure all deployment scripts meet production standards before mainnet deployment.

**When to Use**: Before any mainnet deployment or after refactoring a deployment script.

---

## 🔴 CRITICAL: Mainnet Deployment Prerequisites

Before deploying ANY contract to mainnet, ALL items must be checked:

### 1. Script Refactoring Status

- [ ] Script uses `deployment-utils.ts` library (not inline implementations)
- [ ] Script imports all required utilities:
  - [ ] `checkDeployerBalance`
  - [ ] `estimateDeploymentCost`
  - [ ] `validateMinimumProfit`
  - [ ] `approveRouters`
  - [ ] `verifyContractWithRetry`
  - [ ] `normalizeNetworkName`
  - [ ] Smoke test function (contract-specific or `smokeTestFlashLoanContract`)

### 2. Production Configuration

- [ ] `DEFAULT_MINIMUM_PROFIT` defined for target mainnet
- [ ] Minimum profit threshold is ≥ 0.001 ETH equivalent
- [ ] `APPROVED_ROUTERS` configured for target network
- [ ] Protocol addresses (Factory, Vault, Pool) verified from official docs
- [ ] Network name normalization tested (handles aliases)

### 3. Error Handling & Safety

- [ ] Script normalizes network name at start: `normalizeNetworkName(network.name)`
- [ ] Script validates minimum profit: `validateMinimumProfit(networkName, minimumProfit)`
- [ ] Script uses retry logic for verification: `verifyContractWithRetry(...)`
- [ ] Script handles router approval failures: `approveRouters(..., true)`
- [ ] Script has post-deployment smoke tests
- [ ] All error messages use `[ERR_CODE]` prefix format

### 4. Testing Validation

- [ ] Deployment succeeds on hardhat local network
- [ ] Deployment succeeds on testnet (sepolia, arbitrumSepolia, etc.)
- [ ] Verification succeeds on testnet block explorer
- [ ] Smoke tests pass on testnet deployment
- [ ] Error scenarios tested:
  - [ ] Insufficient balance → clear error message with required amount
  - [ ] Zero profit on mainnet → throws `[ERR_NO_PROFIT_THRESHOLD]`
  - [ ] Missing configuration → throws with actionable fix instructions
  - [ ] Gas estimation failure → graceful degradation
  - [ ] Verification failure → provides manual verification command

### 5. Documentation & Configuration

- [ ] Constructor arguments documented in script header
- [ ] Environment variables documented in script header
- [ ] Post-deployment steps documented (approve routers, set config, etc.)
- [ ] Script references correct documentation files
- [ ] Registry file name matches contract type (e.g., `pancakeswap-registry.json`)

### 6. Code Quality

- [ ] TypeScript compiles without errors: `npm run typecheck`
- [ ] No ESLint warnings: `npm run lint`
- [ ] Contract-specific `DeploymentResult` interface extends base type
- [ ] No hardcoded delays (use `verifyContractWithRetry` with configurable delay)
- [ ] No sequential RPC calls where parallel possible (pool discovery, etc.)

### 7. Security Review

- [ ] Private keys not hardcoded (uses environment variables)
- [ ] No sensitive data logged to console
- [ ] Owner address validation (not zero address)
- [ ] Deployer has sufficient balance for gas costs
- [ ] Contract will not accept unprofitable trades (minimum profit validated)

### 8. Approval & Sign-Off

- [ ] Code reviewed by second developer
- [ ] Testnet deployment validated by QA
- [ ] Security checklist reviewed
- [ ] Deployment plan approved by tech lead
- [ ] Emergency rollback plan documented

---

## 🟡 Script-Specific Checklists

### For Flash Loan Arbitrage Scripts

- [ ] Flash loan provider address validated from official docs
- [ ] Flash loan fee documented in script comments
- [ ] Router addresses validated from DEX official docs
- [ ] Approved routers support the tokens being traded
- [ ] Minimum profit accounts for flash loan fees

### For PancakeSwap Deployment

- [ ] Factory address matches PancakeSwap V3 official deployment
- [ ] Pool discovery completed (if using batch whitelisting)
- [ ] `whitelistMultiplePools` called with discovered pools
- [ ] Fee tiers configured: [100, 500, 2500, 10000]

### For Balancer Deployment

- [ ] Vault address matches Balancer V2 official deployment
- [ ] 0% flash loan fee advantage documented
- [ ] Cost savings calculation included in output

### For SyncSwap Deployment

- [ ] Vault address matches SyncSwap official deployment (zkSync Era)
- [ ] Network is zkSync Era (mainnet or testnet)
- [ ] 0.3% flash loan fee documented

### For CommitReveal Deployment

- [ ] MIN_DELAY_BLOCKS and MAX_COMMIT_AGE_BLOCKS smoke tested
- [ ] No router approval step (stateless contract)
- [ ] Commit-reveal flow documented in post-deployment steps

### For MultiPathQuoter Deployment

- [ ] No constructor arguments (stateless contract)
- [ ] Smoke test uses valid test data (not empty array)
- [ ] Performance benefits documented (batch quoting)

---

## 🟢 Post-Deployment Validation

After successful deployment:

- [ ] Contract address recorded in `deployments/addresses.ts`
- [ ] Contract verified on block explorer
- [ ] Smoke tests passed
- [ ] Router approvals succeeded (or failures documented for manual retry)
- [ ] Minimum profit threshold set correctly
- [ ] Owner address is correct (deployer or specified owner)
- [ ] Registry files updated with deployment result
- [ ] Service configurations updated (if applicable)

### Verification Steps

```bash
# 1. Check contract on block explorer
# - Verify source code is published
# - Check constructor arguments match
# - Verify owner is correct

# 2. Read contract state
npx hardhat console --network <NETWORK>
> const contract = await ethers.getContractAt('<CONTRACT>', '<ADDRESS>');
> await contract.owner() // Should match expected owner
> await contract.paused() // Should be false
> await contract.minimumProfit() // Should be > 0 on mainnet

# 3. Test basic functionality (READ-ONLY)
# Do NOT execute real trades on mainnet without approval
```

---

## 🔴 Mainnet Deployment Guard

**CRITICAL**: Before executing mainnet deployment:

1. **Verify refactoring status**:
   ```bash
   # Script should use deployment-utils.ts
   grep -l "from './lib/deployment-utils'" contracts/scripts/deploy-*.ts
   ```

2. **Verify mainnet thresholds defined**:
   ```bash
   # Check for mainnet profit thresholds
   grep -A 20 "DEFAULT_MINIMUM_PROFIT" contracts/scripts/deploy-*.ts | grep "ethereum:"
   ```

3. **Test on testnet first**:
   ```bash
   # Always deploy to testnet before mainnet
   npx hardhat run scripts/deploy-<CONTRACT>.ts --network sepolia
   ```

4. **Get approval**:
   - [ ] Tech lead approval
   - [ ] Security review approval (for first deployment of contract type)
   - [ ] Budget approval (gas costs)

---

## ⚠️ If Script Fails Checklist

If any item above is NOT checked:

**🛑 DO NOT DEPLOY TO MAINNET**

Instead:

1. Complete the missing items
2. Re-run the checklist
3. Get approval from tech lead
4. Only then proceed with mainnet deployment

---

## Emergency Rollback Procedures

If deployment fails or issues discovered post-deployment:

### Scenario 1: Deployment Failed Mid-Execution

**Symptoms**: Contract deployed but configuration incomplete (router approvals failed, verification failed, etc.)

**Actions**:
1. Do NOT use the contract for trading
2. Check deployment registry for partial deployment details
3. Manually complete configuration:
   ```bash
   npx hardhat console --network <NETWORK>
   > const contract = await ethers.getContractAt('<CONTRACT>', '<ADDRESS>');
   > await contract.addApprovedRouter('<ROUTER_ADDRESS>');
   ```
4. Re-run smoke tests manually
5. Verify on block explorer if verification failed

### Scenario 2: Incorrect Configuration Deployed

**Symptoms**: Contract deployed with wrong parameters (zero profit, wrong owner, etc.)

**Actions**:
1. Pause contract if possible: `await contract.pause()`
2. Do NOT update addresses.ts with incorrect deployment
3. Redeploy with correct configuration
4. Update registry with new deployment (keep old entry for audit trail)

### Scenario 3: Contract Has Critical Bug

**Symptoms**: Bug discovered after deployment

**Actions**:
1. Pause contract immediately: `await contract.pause()`
2. Notify team and security
3. Analyze impact and create incident report
4. Deploy fixed version
5. Migrate to new contract if necessary

---

## Checklist Signature

**Deployment Operator**: _________________
**Date**: _________________
**Network**: _________________
**Contract**: _________________
**Address**: _________________

**Code Reviewer**: _________________
**Date**: _________________

**Tech Lead Approval**: _________________
**Date**: _________________

---

## Appendix: Quick Reference Commands

### Testnet Deployments

```bash
# Sepolia (Ethereum testnet)
npx hardhat run scripts/deploy-<CONTRACT>.ts --network sepolia

# Arbitrum Sepolia
npx hardhat run scripts/deploy-<CONTRACT>.ts --network arbitrumSepolia

# Base Sepolia
npx hardhat run scripts/deploy-<CONTRACT>.ts --network baseSepolia

# zkSync Sepolia
npx hardhat run scripts/deploy-<CONTRACT>.ts --network zksync-testnet
```

### Mainnet Deployments (REQUIRES APPROVAL)

```bash
# Ethereum Mainnet
npx hardhat run scripts/deploy-<CONTRACT>.ts --network ethereum

# Arbitrum One
npx hardhat run scripts/deploy-<CONTRACT>.ts --network arbitrum

# BSC Mainnet
npx hardhat run scripts/deploy-<CONTRACT>.ts --network bsc

# Base Mainnet
npx hardhat run scripts/deploy-<CONTRACT>.ts --network base
```

### Verification (Manual)

```bash
# If auto-verification failed
npx hardhat verify --network <NETWORK> <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS...>

# Example for FlashLoanArbitrage
npx hardhat verify --network ethereum 0x... 0xAAVE_POOL 0xOWNER

# Example for PancakeSwapFlashArbitrage
npx hardhat verify --network bsc 0x... 0xFACTORY 0xOWNER
```

### Contract Interaction (Read-Only)

```bash
# Open console
npx hardhat console --network <NETWORK>

# Load contract
> const contract = await ethers.getContractAt('<CONTRACT_NAME>', '<ADDRESS>');

# Read state
> await contract.owner()
> await contract.paused()
> await contract.minimumProfit()
> await contract.APPROVED_ROUTERS(0)  # Check first router
```

---

**Version**: 1.0
**Last Updated**: 2026-02-10
**Maintained By**: Engineering Team
**Review Schedule**: Monthly or after major changes
