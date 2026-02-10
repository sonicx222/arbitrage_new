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

### Current State (Before Standardization)

| Contract | Protocol Error | Caller Error | Initiator Error |
|----------|----------------|--------------|-----------------|
| FlashLoanArbitrage | `InvalidPoolAddress` | `InvalidFlashLoanCaller` ✅ | `InvalidFlashLoanInitiator` ✅ |
| BalancerV2FlashArbitrage | `InvalidVaultAddress` | `InvalidFlashLoanCaller` ✅ | N/A |
| PancakeSwapFlashArbitrage | `InvalidFactoryAddress` | `InvalidFlashLoanCaller` ✅ | N/A |
| SyncSwapFlashArbitrage | `InvalidVaultAddress` | `InvalidFlashLoanCaller` ✅ | `InvalidInitiator` ❌ |

### Target State (After Standardization)

| Contract | Protocol Error | Caller Error | Initiator Error |
|----------|----------------|--------------|-----------------|
| FlashLoanArbitrage | `InvalidProtocolAddress` | `InvalidFlashLoanCaller` ✅ | `InvalidFlashLoanInitiator` ✅ |
| BalancerV2FlashArbitrage | `InvalidProtocolAddress` | `InvalidFlashLoanCaller` ✅ | N/A |
| PancakeSwapFlashArbitrage | `InvalidProtocolAddress` | `InvalidFlashLoanCaller` ✅ | N/A |
| SyncSwapFlashArbitrage | `InvalidProtocolAddress` | `InvalidFlashLoanCaller` ✅ | `InvalidFlashLoanInitiator` |

## Migration Guide

For each contract, update error definitions and usage:

### FlashLoanArbitrage.sol

```solidity
// OLD
error InvalidPoolAddress();

// NEW
error InvalidProtocolAddress();

// Update usage in constructor
if (_pool == address(0)) revert InvalidProtocolAddress();
```

### BalancerV2FlashArbitrage.sol

```solidity
// OLD
error InvalidVaultAddress();

// NEW
error InvalidProtocolAddress();

// Update usage in constructor
if (_vault == address(0)) revert InvalidProtocolAddress();
```

### PancakeSwapFlashArbitrage.sol

```solidity
// OLD
error InvalidFactoryAddress();
error InvalidPoolAddress();

// NEW
error InvalidProtocolAddress();
// Note: Use same error for both factory and pool validation

// Update usage in constructor
if (_factory == address(0)) revert InvalidProtocolAddress();
```

### SyncSwapFlashArbitrage.sol

```solidity
// OLD
error InvalidVaultAddress();
error InvalidInitiator();

// NEW
error InvalidProtocolAddress();
error InvalidFlashLoanInitiator();

// Update usage
if (_vault == address(0)) revert InvalidProtocolAddress();
if (initiator != address(this)) revert InvalidFlashLoanInitiator();
```

## Benefits

1. **Unified Monitoring**: Single error pattern to track across all protocols
2. **Better DX**: Developers memorize one error name, not four
3. **Reduced Code**: Shared error handling logic
4. **Clearer Intent**: "Protocol" is protocol-agnostic (works for Pool, Vault, Factory)

## Backward Compatibility

**Breaking Change**: Yes - changes error names that external code may catch

**Migration Path**:
1. Update monitoring/alerting to recognize new error names
2. Update integration tests
3. Deploy new contracts with standardized errors
4. No runtime behavior changes (same validations, just different error names)

## Future Additions

As new flash loan providers are added, use these standardized errors:
- Protocol address validation: `InvalidProtocolAddress()`
- Callback caller check: `InvalidFlashLoanCaller()`
- Initiator validation: `InvalidFlashLoanInitiator()`

## See Also

- Individual contract error definitions (before standardization)
- Deep dive analysis: contracts/INTERFACE_DEEP_DIVE_ANALYSIS.md Section 5
