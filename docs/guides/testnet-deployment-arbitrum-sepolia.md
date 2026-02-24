# Deploying FlashLoanArbitrage to Arbitrum Sepolia

This guide walks through deploying the first smart contract to a real blockchain (Arbitrum Sepolia testnet). After completing this guide, you will have a live contract capable of executing Aave V3 flash loan arbitrage on testnet.

**Prerequisites:** Node.js >= 22, project dependencies installed (`npm install`), contracts compile (`cd contracts && npx hardhat compile`).

**Cost:** $0 -- everything uses free testnet resources.

---

## What's Already Configured

The codebase is fully prepared for Arbitrum Sepolia deployment:

| Component | File | Value |
|-----------|------|-------|
| Network config | `contracts/hardhat.config.ts:74-78` | chainId 421614, default RPC |
| Aave V3 Pool | `shared/config/src/addresses.ts:85` | `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` |
| Approved V2 Router | `contracts/deployments/addresses.ts:291-293` | `0x101F443B4d1b059569D643917553c771E1b9663E` |
| Test tokens | `contracts/deployments/addresses.ts:373-376` | WETH + USDC |
| Registry entry | `contracts/deployments/registry.json:41-51` | Slot exists (all null) |
| Deploy script | `contracts/scripts/deploy.ts` | Full pipeline |

---

## Step 1: Create a Deployer Wallet

Create a wallet **exclusively for testnet use**. Never use a wallet that holds real funds.

### Option A: MetaMask

1. Open MetaMask, click your account icon, select "Add account or hardware wallet", then "Add a new account"
2. Name it "Arbitrum Sepolia Deployer"
3. Click the three dots, then "Account details", then "Show private key"
4. Copy the private key (starts with `0x`)
5. Copy the public address (starts with `0x`)

### Option B: Command Line

```bash
node -e "const w = require('ethers').Wallet.createRandom(); console.log('Address:', w.address); console.log('Private Key:', w.privateKey);"
```

Save both the **address** and **private key**. You need the address for the faucet and the private key for deployment.

---

## Step 2: Get Arbitrum Sepolia Testnet ETH

You need ~0.05 ETH on Arbitrum Sepolia for deployment gas. Try these faucets in order:

1. **Alchemy Faucet** (most reliable): https://www.alchemy.com/faucets/arbitrum-sepolia
   - Requires a free Alchemy account
   - Paste your deployer wallet address
   - Gives 0.1 ETH per day

2. **QuickNode Faucet**: https://faucet.quicknode.com/arbitrum/sepolia
   - Requires a free QuickNode account

3. **Bridge from Sepolia**: If you already have Sepolia ETH:
   - Get Sepolia ETH from https://www.alchemy.com/faucets/ethereum-sepolia
   - Bridge to Arbitrum Sepolia via https://bridge.arbitrum.io/?destinationChain=arbitrum-sepolia

### Verify Your Balance

```bash
# Replace YOUR_ADDRESS with your deployer wallet address
curl -s -X POST https://sepolia-rollup.arbitrum.io/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["YOUR_ADDRESS","latest"],"id":1}' \
  | node -e "const d=require('fs').readFileSync(0,'utf8');const r=JSON.parse(d);console.log('Balance:',parseInt(r.result,16)/1e18,'ETH')"
```

You need at least **0.01 ETH**. Deployment costs roughly 0.003-0.008 ETH on Arbitrum Sepolia.

---

## Step 3: Set Up Environment Variables

Create `.env.local` in the **project root** (this file is gitignored -- secrets never get committed):

```bash
# File: .env.local (project root)

# ─── Deployment Credentials ───
DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# ─── RPC (optional, the default public endpoint works for testnet) ───
# ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc

# ─── Contract Verification (optional but recommended) ───
# Get a free API key from https://arbiscan.io/myapikey
# ARBISCAN_API_KEY=YOUR_ARBISCAN_API_KEY
```

Replace `0xYOUR_PRIVATE_KEY_HERE` with your actual private key from Step 1. The `0x` prefix is required.

---

## Step 4: Compile the Contracts

```bash
cd contracts
npx hardhat compile
```

Expected output:

```
Compiled 25 Solidity files successfully (with viaIR enabled)
```

If you see errors, clean and retry:

```bash
npx hardhat clean
npx hardhat compile
```

The first compilation with `viaIR` can be slow (1-3 minutes). This is normal.

---

## Step 5: Deploy FlashLoanArbitrage

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network arbitrumSepolia
```

### What the Script Does Automatically

1. Connects to Arbitrum Sepolia via RPC
2. Looks up the Aave V3 Pool address (`0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff`)
3. Deploys `FlashLoanArbitrage` with constructor args `[aavePoolAddress, deployerAddress]`
4. Configures minimum profit (non-zero, enforced by contract)
5. Approves the V2 router `0x101F443B4d1b059569D643917553c771E1b9663E`
6. Attempts Etherscan verification (if `ARBISCAN_API_KEY` is set)
7. Saves the result to `contracts/deployments/registry.json`
8. Prints a summary with the deployed address and next steps

### Expected Output

```
Starting FlashLoanArbitrage deployment to arbitrumSepolia...

Deployer: 0xYourAddress
Network: arbitrumSepolia (chainId: 421614)
Aave V3 Pool: 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff

Deploying FlashLoanArbitrage...
FlashLoanArbitrage deployed to: 0x<NEW_CONTRACT_ADDRESS>
Transaction hash: 0x<TX_HASH>

Configuring minimum profit...
Approving router: 0x101F443B4d1b059569D643917553c771E1b9663E

NEXT STEPS:
1. Update contract address in configuration...
```

**Save the contract address from the output.** You need it for the following steps.

---

## Step 6: Record the Deployed Address

### 6a. Verify the Registry Was Updated

The deploy script updates `contracts/deployments/registry.json` automatically. Verify:

```bash
cat contracts/deployments/registry.json | grep -A2 FlashLoanArbitrage
```

You should see your new address instead of `null` under the `arbitrumSepolia` section.

### 6b. Update the Address Map

Edit `contracts/deployments/addresses.ts` and find the `FLASH_LOAN_CONTRACT_ADDRESSES` section (around line 177). Add your deployed address:

```typescript
export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
  arbitrumSepolia: '0xYOUR_DEPLOYED_ADDRESS_HERE',
};
```

---

## Step 7: Verify the Contract on Arbiscan (Optional)

If verification did not happen automatically during deployment:

```bash
cd contracts
npx hardhat verify --network arbitrumSepolia \
  0xYOUR_DEPLOYED_ADDRESS \
  0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff \
  0xYOUR_DEPLOYER_ADDRESS
```

The two arguments after the contract address are the constructor args: `[aavePoolAddress, ownerAddress]`.

After verification, view and interact with the contract at:
`https://sepolia.arbiscan.io/address/0xYOUR_DEPLOYED_ADDRESS`

---

## Step 8: Verify the Deployment Works

### 8a. Typecheck

```bash
npm run typecheck
```

This confirms the address update in `addresses.ts` compiles correctly.

### 8b. Read On-Chain State

```bash
cd contracts
npx hardhat console --network arbitrumSepolia
```

In the Hardhat console:

```javascript
const contract = await ethers.getContractAt(
  "FlashLoanArbitrage",
  "0xYOUR_DEPLOYED_ADDRESS"
);

// Check owner
console.log("Owner:", await contract.owner());

// Check if router is approved
console.log("Router approved:", await contract.isApprovedRouter(
  "0x101F443B4d1b059569D643917553c771E1b9663E"
));

// Check minimum profit
console.log("Min profit:", (await contract.minimumProfit()).toString());

// Check pause state
console.log("Paused:", await contract.paused());
```

Expected results:
- **Owner** = your deployer address
- **Router approved** = `true`
- **Min profit** = non-zero value
- **Paused** = `false`

Type `.exit` to leave the console.

---

## Step 9: Test a Flash Loan Call (Optional)

This tests whether the Aave V3 flash loan integration is wired correctly. On testnet this will revert because there is no profitable arbitrage path, but the revert reason confirms the contract is live and responding.

```bash
cd contracts
npx hardhat console --network arbitrumSepolia
```

```javascript
const contract = await ethers.getContractAt(
  "FlashLoanArbitrage",
  "0xYOUR_DEPLOYED_ADDRESS"
);

try {
  const tx = await contract.executeArbitrage(
    "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", // WETH on Arb Sepolia
    ethers.parseEther("0.001"),                     // tiny amount
    [],                                             // empty swap path
    0,                                              // minProfit
    { gasLimit: 500000 }
  );
  await tx.wait();
} catch (e) {
  console.log("Reverted with:", e.reason || e.message);
}
```

- `EmptySwapPath` or `InsufficientProfit` = contract is live and working correctly
- `execution reverted` without a reason = Aave V3 pool may not support the token on testnet

---

## Step 10: Commit the Deployment Record

```bash
git add contracts/deployments/registry.json contracts/deployments/addresses.ts
git commit -m "deploy: FlashLoanArbitrage to Arbitrum Sepolia testnet

Contract: 0xYOUR_ADDRESS
Network: arbitrumSepolia (chainId 421614)
Aave V3 Pool: 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff
Approved Router: 0x101F443B4d1b059569D643917553c771E1b9663E"
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `DEPLOYER_PRIVATE_KEY not set` | `.env.local` not loading | Ensure the file is in the project root, not in `contracts/` |
| `insufficient funds for gas` | Not enough testnet ETH | Use a faucet from Step 2 |
| `ERR_NO_AAVE_POOL` | Missing pool address | Already configured; should not happen |
| `could not detect network` | RPC connectivity issue | Set `ARBITRUM_SEPOLIA_RPC_URL` to a dedicated endpoint (e.g., Alchemy) |
| Compilation fails | Stale build cache | `cd contracts && npx hardhat clean && npx hardhat compile` |
| Verification fails | Missing API key or rate limit | Set `ARBISCAN_API_KEY` in `.env.local`, or wait a minute and retry |
| `nonce too low` | Previous pending transaction | Wait 30 seconds and retry |
| Very slow compilation | `viaIR` optimizer | Normal on first run (1-3 min). Set `DISABLE_VIA_IR=true` for faster builds with larger bytecode |

---

## What You Have After Completing This Guide

- A live `FlashLoanArbitrage` contract on Arbitrum Sepolia
- Aave V3 flash loan integration verified on-chain
- One approved V2 DEX router
- Contract address recorded in the codebase (`registry.json` + `addresses.ts`)
- Ready for Phase 3 (UniswapV3Adapter) to expand DEX coverage beyond V2 routers
