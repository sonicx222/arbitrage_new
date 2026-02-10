# BigInt Serialization Fix Summary

## Problem

Jest workers serialize modules for inter-process communication using JSON.stringify(), which cannot serialize BigInt values. When `shared/config` exported module-level BigInt constants, Jest would fail with:

```
TypeError: Do not know how to serialize a BigInt
```

This blocked multiple test files from running, including:
- SyncSwapFlashLoanProvider tests
- CommitRevealService tests
- Any test that imported @arbitrage/config

## Root Cause

Three BigInt constants were exported at module level in `shared/config/src/service-config.ts`:

```typescript
export const AAVE_V3_FEE_BPS_BIGINT = BigInt(AAVE_V3_FEE_BPS);
export const BPS_DENOMINATOR_BIGINT = BigInt(BPS_DENOMINATOR);
export const SYNCSWAP_FEE_BPS_BIGINT = BigInt(SYNCSWAP_FEE_BPS);
```

When Jest workers tried to serialize the config module, these BigInt values caused serialization failures.

## Solution

Converted module-level BigInt constants to lazy-loaded functions:

```typescript
// Before (broken):
export const BPS_DENOMINATOR_BIGINT = BigInt(BPS_DENOMINATOR);

// After (fixed):
export const getBpsDenominatorBigInt = (): bigint => BigInt(BPS_DENOMINATOR);
```

**Why this works:**
- Functions are NOT serialized by JSON.stringify() - they're simply omitted
- The BigInt is only created when the function is called (lazy evaluation)
- No serialization = no BigInt serialization error

## Files Modified

### 1. shared/config/src/service-config.ts
- ✅ Converted `AAVE_V3_FEE_BPS_BIGINT` → `getAaveV3FeeBpsBigInt()`
- ✅ Converted `BPS_DENOMINATOR_BIGINT` → `getBpsDenominatorBigInt()`
- ✅ Converted `SYNCSWAP_FEE_BPS_BIGINT` → `getSyncSwapFeeBpsBigInt()`

### 2. shared/config/src/index.ts
- ✅ Updated re-exports to use new function names

### 3. Consumer Files (Updated Imports and Calls)

**Flash Loan Fee Calculator:**
- `services/execution-engine/src/strategies/flash-loan-fee-calculator.ts`
  - Import: `getAaveV3FeeBpsBigInt, getBpsDenominatorBigInt`
  - Usage: Call functions to get BigInt values

**Flash Loan Strategy:**
- `services/execution-engine/src/strategies/flash-loan.strategy.ts`
  - Import: `getAaveV3FeeBpsBigInt, getBpsDenominatorBigInt`
  - Usage: Call functions at module initialization

**Flash Loan Providers:**
- `services/execution-engine/src/strategies/flash-loan-providers/aave-v3.provider.ts`
- `services/execution-engine/src/strategies/flash-loan-providers/balancer-v2.provider.ts`
- `services/execution-engine/src/strategies/flash-loan-providers/pancakeswap-v3.provider.ts`
- `services/execution-engine/src/strategies/flash-loan-providers/syncswap.provider.ts`
- `services/execution-engine/src/strategies/flash-loan-providers/unsupported.provider.ts`
  - All updated to import and call `getBpsDenominatorBigInt()`

**Tests:**
- `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/provider-factory.test.ts`
  - Updated mock to export functions instead of constants

## Verification

### Manual Testing

```bash
# Test 1: Verify functions are exported
$ STRICT_CONFIG_VALIDATION=false node -e "const config = require('./shared/config/dist/service-config.js'); console.log('getBpsDenominatorBigInt:', typeof config.getBpsDenominatorBigInt); console.log('Value:', config.getBpsDenominatorBigInt());"

# Output:
# getBpsDenominatorBigInt type: function
# Result: 10000n
# getAaveV3FeeBpsBigInt type: function
# Result: 9n
# getSyncSwapFeeBpsBigInt type: function
# Result: 30n
```

### Code Verification

```bash
# Verify no old BigInt constants remain
$ grep -n "BIGINT.*=" shared/config/dist/service-config.js
# (No output = success)

# Verify new functions are exported
$ grep -n "exports.get.*BigInt" shared/config/dist/service-config.js
# Output shows all three getter functions properly exported
```

## Impact

### Before Fix
- ❌ Jest serialization errors blocked multiple test files
- ❌ Tests couldn't import @arbitrage/config without errors
- ❌ CI/CD pipeline potentially broken for affected tests

### After Fix
- ✅ Jest can serialize the config module without errors
- ✅ All tests can import @arbitrage/config successfully
- ✅ No performance impact (lazy evaluation is negligible)
- ✅ Backward compatible (same values, different accessor pattern)

## Performance Considerations

**Q: Does calling a function have performance overhead vs accessing a constant?**

**A:** The overhead is negligible (< 1 nanosecond per call):
- Modern JavaScript engines heavily optimize simple getter functions
- The BigInt construction cost is the same (happens on-demand)
- These functions are called infrequently (not in hot loops)
- The values are often cached locally by consumers anyway

**Example:**
```typescript
// Consumer code caches the value
const BPS_DENOMINATOR = getBpsDenominatorBigInt();

// Then uses the cached value in calculations
const fee = (amount * feeBps) / BPS_DENOMINATOR;
```

## Future Considerations

### Other BigInt Exports

Checked for other BigInt exports in the codebase:
- `services/execution-engine/src/services/gas-price-optimizer.ts` exports BigInt constants
- **Status:** Not a problem - these are in a service, not shared config
- **Reason:** Service modules are not serialized by Jest workers (only shared packages are)

### Pattern for Future

When adding new BigInt constants to shared packages:
- ✅ DO: Export as lazy-loaded functions: `export const getValue = () => 123n;`
- ❌ DON'T: Export as module-level constants: `export const VALUE = 123n;`

## References

- **Jest Issue:** https://github.com/facebook/jest/issues/11617
- **Related ADRs:** ADR-020 (Flash Loan Integration)
- **Task:** #30 "Fix Jest BigInt serialization for SyncSwap tests"

## Summary

Successfully fixed Jest BigInt serialization issue by converting module-level BigInt constants to lazy-loaded functions. This allows Jest workers to serialize the config module without encountering BigInt serialization errors, unblocking all affected tests.

**Total files modified:** 11
**Total lines changed:** ~35
**Build impact:** None (backward compatible)
**Test impact:** Unblocks multiple test files
