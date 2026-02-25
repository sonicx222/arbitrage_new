# Ownership Transfer to Multi-Sig Guide

> **Last Updated:** 2026-02-25
> **Applies to:** All contracts inheriting `BaseFlashArbitrage` (Ownable2Step)
> **When to use:** After mainnet deployment is stable and validated

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Ownable2Step Transfer Process](#3-ownable2step-transfer-process)
4. [Post-Transfer Verification](#4-post-transfer-verification)
5. [Admin Functions Reference](#5-admin-functions-reference)
6. [Emergency Procedures](#6-emergency-procedures)

---

## 1. Overview

All arbitrage contracts use OpenZeppelin's **Ownable2Step** pattern (OZ 4.9.6). This provides a two-step ownership transfer that prevents accidental loss of ownership:

1. Current owner calls `transferOwnership(newOwner)` — sets pending owner
2. New owner calls `acceptOwnership()` — completes the transfer

The owner controls admin functions (pause, withdraw, configuration) but does **not** control trade execution. The `executeArbitrage()` function uses open access — the atomic flash loan model with profit verification prevents fund extraction.

### Why Transfer to Multi-Sig?

| Risk | Single-Key Owner | Multi-Sig Owner |
|------|-----------------|-----------------|
| Key compromise | Attacker can pause, withdraw, reconfigure | Requires M-of-N signers |
| Key loss | Permanent loss of admin control | Other signers retain access |
| Rogue operator | Single point of trust | Distributed governance |

### Recommended Multi-Sig

- **Safe (formerly Gnosis Safe)** — https://safe.global
- **2-of-3** threshold for small teams
- **3-of-5** threshold for larger operations

---

## 2. Prerequisites

Before transferring ownership:

- [ ] Contract is deployed and verified on block explorer
- [ ] All post-deployment checks pass (see [Post-Deployment Checklist](./post-deployment-checklist.md))
- [ ] Contract has been operating successfully for at least 24 hours
- [ ] Multi-sig wallet is deployed on the target chain
- [ ] Multi-sig wallet address is confirmed correct (double-check on block explorer)
- [ ] All multi-sig signers have been added and threshold is set
- [ ] `withdrawGasLimit` is set to at least 50000 (supports multi-sig `receive()`)

### Verify withdrawGasLimit

Multi-sig wallets need more gas for ETH transfers than EOAs. The default `withdrawGasLimit` of 50000 is sufficient for Safe wallets.

```bash
npx hardhat console --network <chain>
> const contract = await ethers.getContractAt('<ContractType>', '<address>')
> await contract.withdrawGasLimit()
# Should be 50000 or higher
```

If it's lower (e.g., 2300 for plain EOA transfers):

```bash
> await contract.setWithdrawGasLimit(50000)
```

---

## 3. Ownable2Step Transfer Process

### Step 1: Initiate Transfer (Current Owner)

```bash
npx hardhat console --network <chain>

> const contract = await ethers.getContractAt('<ContractType>', '<contractAddress>')

# Verify current ownership
> const currentOwner = await contract.owner()
> console.log('Current owner:', currentOwner)

# Verify no pending transfer
> const pending = await contract.pendingOwner()
> console.log('Pending owner:', pending)
# Should be 0x0000000000000000000000000000000000000000

# Initiate transfer to multi-sig
> const MULTISIG_ADDRESS = '0xYOUR_SAFE_ADDRESS'
> const tx = await contract.transferOwnership(MULTISIG_ADDRESS)
> await tx.wait()
> console.log('Transfer initiated. Tx:', tx.hash)

# Verify pending owner is set
> const newPending = await contract.pendingOwner()
> console.log('Pending owner:', newPending)
# Should be the multi-sig address
```

> [!IMPORTANT]
> At this point, the original owner is STILL the owner. The transfer is not complete until the multi-sig calls `acceptOwnership()`.

### Step 2: Accept Transfer (Multi-Sig)

The multi-sig must call `acceptOwnership()` on the contract. This requires a multi-sig transaction.

#### Using Safe (Gnosis Safe) UI

1. Go to https://app.safe.global
2. Connect the Safe wallet on the correct chain
3. Click **New Transaction** > **Contract Interaction**
4. Enter the contract address
5. Paste the ABI (or use the verified contract ABI from the block explorer)
6. Select the `acceptOwnership()` function
7. Submit and collect required signatures
8. Execute the transaction

#### Using Safe Transaction Builder

```json
{
  "to": "<contractAddress>",
  "value": "0",
  "data": "0x79ba5097",
  "operation": 0
}
```

The function selector `0x79ba5097` is `acceptOwnership()` (no arguments).

### Step 3: Verify Transfer

```bash
> const contract = await ethers.getContractAt('<ContractType>', '<contractAddress>')
> const owner = await contract.owner()
> console.log('New owner:', owner)
# Should be the multi-sig address

> const pending = await contract.pendingOwner()
> console.log('Pending owner:', pending)
# Should be 0x0000000000000000000000000000000000000000
```

### Step 4: Cancel Transfer (If Needed)

If the transfer was initiated in error, the current owner can cancel by transferring to a different address or to themselves:

```bash
# Cancel by re-transferring to self
> await contract.transferOwnership(await contract.owner())
```

---

## 4. Post-Transfer Verification

After the multi-sig accepts ownership, verify all admin functions work through the multi-sig:

### Test Pause/Unpause

1. From Safe UI, call `pause()` on the contract
2. Verify `paused()` returns `true`
3. From Safe UI, call `unpause()`
4. Verify `paused()` returns `false`

### Test Configuration Change

1. From Safe UI, call `setMinimumProfit(newValue)`
2. Verify `minimumProfit()` returns the new value
3. Reset to the original value

### Verify Open Access Still Works

The `executeArbitrage()` function should still be callable by anyone (the execution engine uses a different wallet):

```bash
# This should NOT revert with "Ownable: caller is not the owner"
# (It may revert for other reasons like insufficient profit, which is expected)
> await contract.executeArbitrage(...)
```

---

## 5. Admin Functions Reference

Functions that require `onlyOwner` (must be called via multi-sig after transfer):

| Function | Purpose | Parameters |
|----------|---------|------------|
| `addApprovedRouter(address)` | Whitelist a DEX router | Router address |
| `removeApprovedRouter(address)` | Remove a DEX router | Router address |
| `setMinimumProfit(uint256)` | Set profit threshold | Amount in wei (rejects 0) |
| `setSwapDeadline(uint256)` | Set swap deadline | Seconds (1-600) |
| `setWithdrawGasLimit(uint256)` | Set ETH withdraw gas | Gas units (2300-500000) |
| `pause()` | Emergency pause | None |
| `unpause()` | Resume operations | None |
| `withdrawToken(address, address, uint256)` | Recover ERC20 | Token, recipient, amount |
| `withdrawETH(address payable, uint256)` | Recover ETH | Recipient, amount |
| `transferOwnership(address)` | Start ownership transfer | New owner address |

Functions that remain open access (no owner restriction):

| Function | Purpose |
|----------|---------|
| `executeArbitrage(...)` | Execute flash loan arbitrage |
| `commit(bytes32)` | Submit commitment (CommitReveal only) |
| `reveal(...)` | Reveal trade (CommitReveal only) |
| `cancelCommitment()` | Cancel own commitment (CommitReveal only) |

---

## 6. Emergency Procedures

### If Multi-Sig Keys Are Compromised

1. **Immediately pause** all contracts from any remaining valid signer
2. **Withdraw** all funds to a secure address
3. **Deploy** new contracts with a new multi-sig
4. **Update** all service configuration to new addresses

### If Multi-Sig Loses Quorum

If enough signers lose access that the threshold cannot be met:

- Contract admin functions become permanently inaccessible
- `executeArbitrage()` continues to work (open access)
- Funds in the contract can only be recovered if profit is generated (returned to the contract, then... stuck)
- This is why a **2-of-3 or 3-of-5** threshold is recommended — losing one signer doesn't lock out admin

### Recommended Multi-Sig Signers

| Signer | Role | Access |
|--------|------|--------|
| Signer 1 | Primary operator | Hardware wallet |
| Signer 2 | Secondary operator | Hardware wallet |
| Signer 3 | Recovery key | Cold storage (safe deposit box) |

For 2-of-3: any two signers can execute admin transactions. Losing one signer still allows operations.

---

## Per-Contract Transfer Checklist

Repeat for each deployed contract on each chain:

```
Contract: _______________
Chain:    _______________
Address:  _______________

[ ] 1. transferOwnership(multisig) called by deployer
[ ] 2. Verified pendingOwner() == multisig address
[ ] 3. acceptOwnership() called from multi-sig
[ ] 4. Verified owner() == multisig address
[ ] 5. Verified pendingOwner() == address(0)
[ ] 6. Tested pause/unpause via multi-sig
[ ] 7. Updated documentation with new owner info
```
