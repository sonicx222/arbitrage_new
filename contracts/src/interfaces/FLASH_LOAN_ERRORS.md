# Standardized Flash Loan Error Names

This document defines the standardized error naming conventions for all flash loan contracts.

## Motivation

Flash loan contracts (Aave, Balancer, PancakeSwap, SyncSwap) currently use inconsistent error names for similar conditions:
- `InvalidPoolAddress` vs `InvalidVaultAddress` vs `InvalidFactoryAddress`
- `InvalidFlashLoanInitiator` vs `InvalidInitiator`

This causes:
- Monitoring complexity (must track multiple error patterns)
- Developer confusion (hard to remember which contract uses which error)
- Duplicated error handling code

## Standardized Error Naming

### Protocol Validation Errors (1xx range conceptually)

**Protocol Address Validation**: Use a single error for all protocol contract addresses

```solidity
/// @notice Protocol contract address is invalid (zero address or not a contract)
/// @dev Use this for: Pool (Aave), Vault (Balancer/SyncSwap), Factory (PancakeSwap)
error InvalidProtocolAddress();
```

**Usage**:
- FlashLoanArbitrage.sol: Replace `InvalidPoolAddress()` → `InvalidProtocolAddress()`
- BalancerV2FlashArbitrage.sol: Replace `InvalidVaultAddress()` → `InvalidProtocolAddress()`
- PancakeSwapFlashArbitrage.sol: Replace `InvalidFactoryAddress()` → `InvalidProtocolAddress()`
- SyncSwapFlashArbitrage.sol: Replace `InvalidVaultAddress()` → `InvalidProtocolAddress()`

### Callback Validation Errors (2xx range conceptually)

**Flash Loan Caller Validation**: Already consistent ✅

```solidity
/// @notice Flash loan callback called by unauthorized contract
/// @dev Only the protocol contract (Pool/Vault) should call the callback
error InvalidFlashLoanCaller();
```

**Status**: Already used consistently across all contracts - no changes needed.

**Flash Loan Initiator Validation**: Standardize initiator check

```solidity
/// @notice Flash loan initiated by unauthorized address
/// @dev Only the contract itself should be the initiator
error InvalidFlashLoanInitiator();
```

**Usage**:
- SyncSwapFlashArbitrage.sol: Replace `InvalidInitiator()` → `InvalidFlashLoanInitiator()`

## Implementation Status

### ✅ Migration Complete (as of 2026-02-11)

All contracts now use standardized error names via `IFlashLoanErrors.sol` shared interface:

| Contract | Protocol Error | Caller Error | Initiator Error | Source |
|----------|----------------|--------------|-----------------|--------|
| FlashLoanArbitrage | `InvalidProtocolAddress` ✅ | `InvalidFlashLoanCaller` ✅ | `InvalidFlashLoanInitiator` ✅ | `IFlashLoanErrors` |
| BalancerV2FlashArbitrage | `InvalidProtocolAddress` ✅ | `InvalidFlashLoanCaller` ✅ | N/A | `IFlashLoanErrors` |
| PancakeSwapFlashArbitrage | `InvalidProtocolAddress` ✅ | `InvalidFlashLoanCaller` ✅ | N/A | `IFlashLoanErrors` |
| SyncSwapFlashArbitrage | `InvalidProtocolAddress` ✅ | `InvalidFlashLoanCaller` ✅ | `InvalidFlashLoanInitiator` ✅ | `IFlashLoanErrors` |

**Shared Interface**: `contracts/src/interfaces/IFlashLoanErrors.sol`

All four contracts inherit `IFlashLoanErrors` instead of declaring errors locally,
preventing future naming drift.

## Benefits

1. **Unified Monitoring**: Single error pattern to track across all protocols
2. **Better DX**: Developers memorize one error name, not four
3. **Reduced Code**: Shared `IFlashLoanErrors` interface (single source of truth)
4. **Clearer Intent**: "Protocol" is protocol-agnostic (works for Pool, Vault, Factory)
5. **Drift Prevention**: Errors defined once, inherited everywhere

## Future Additions

As new flash loan providers are added:
1. Inherit `IFlashLoanErrors` in the new contract
2. Use standardized errors for protocol/caller/initiator validation
3. Define protocol-specific errors locally (e.g., `PoolNotWhitelisted`)

## See Also

- `contracts/src/interfaces/IFlashLoanErrors.sol` - Shared error definitions
