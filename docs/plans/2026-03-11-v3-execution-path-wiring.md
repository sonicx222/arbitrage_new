# V3 Execution Path Wiring Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable flash loan contracts to execute V3 DEX swaps by routing V3 steps through the on-chain UniswapV3Adapter contract, unlocking ~45-55% of DEX liquidity currently unreachable.

**Architecture:** The on-chain `BaseFlashArbitrage` contract only supports V2-style `swapExactTokensForTokens()`. The existing `UniswapV3Adapter` contract (deployed on Arbitrum Sepolia) wraps V3's `exactInputSingle()` behind the V2 `IDexRouter` interface. The off-chain fix is to substitute the adapter's address as the `router` in `SwapStep` whenever `isV3=true`, so the on-chain contract calls the adapter (which delegates to the real V3 router). No Solidity changes needed.

**Tech Stack:** TypeScript, ethers v6, Jest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `shared/config/src/v3-adapter-addresses.ts` | Create | Per-chain UniswapV3Adapter contract address registry |
| `shared/config/src/index.ts` | Modify | Re-export new module |
| `services/execution-engine/src/strategies/flash-loan.strategy.ts` | Modify | Route V3 steps through adapter in `buildExecuteArbitrageCalldata()` |
| `services/execution-engine/src/initialization/strategy-initializer.ts` | Modify | Include adapter address in approved routers |
| `services/execution-engine/__tests__/unit/strategies/v3-execution-path.test.ts` | Create | Tests for V3 adapter routing in flash loan strategy |

## Chunk 1: Config + Strategy Wiring

### Task 1: V3 Adapter Address Registry

**Files:**
- Create: `shared/config/src/v3-adapter-addresses.ts`
- Modify: `shared/config/src/index.ts`

- [ ] **Step 1: Create `v3-adapter-addresses.ts`**

This file provides per-chain UniswapV3Adapter contract addresses. These are the adapter CONTRACTS (not V3 routers — those are already in `dex-lookup.service.ts`). The adapter wraps V3 behind V2's `IDexRouter` interface so `BaseFlashArbitrage.executeSingleSwap()` can call it.

```typescript
// shared/config/src/v3-adapter-addresses.ts

/**
 * UniswapV3Adapter contract addresses per chain.
 *
 * These are the on-chain adapter contracts that wrap Uniswap V3's
 * exactInputSingle() behind the V2 IDexRouter interface, enabling
 * BaseFlashArbitrage to route through V3 liquidity.
 *
 * The adapter address is substituted as SwapStep.router for V3 steps
 * in flash loan calldata. The adapter then delegates to the chain's
 * real V3 SwapRouter.
 *
 * Addresses are populated after deployment via `deploy-v3-adapter.ts`.
 * Chains with null have no adapter deployed yet — V3 steps on those
 * chains will fall back to a warning log and skip.
 *
 * @see contracts/src/adapters/UniswapV3Adapter.sol
 * @see contracts/deployments/registry.json (UniswapV3Adapter field)
 */
export const V3_ADAPTER_ADDRESSES: Readonly<Record<string, string | null>> = {
  // Testnets (deployed)
  arbitrumSepolia: '0x1A9838ce19Ae905B4e5941a17891ba180F30F630',

  // Mainnets (null = not yet deployed)
  ethereum: null,
  arbitrum: null,
  base: null,
  optimism: null,
  polygon: null,
  bsc: null,
  avalanche: null,
  fantom: null,
  linea: null,
  zksync: null,
  blast: null,
  scroll: null,
  mantle: null,
  mode: null,
};

/**
 * Get the UniswapV3Adapter contract address for a chain.
 *
 * @param chain - Chain identifier
 * @returns Adapter address or null if not deployed on this chain
 */
export function getV3AdapterAddress(chain: string): string | null {
  return V3_ADAPTER_ADDRESSES[chain] ?? null;
}

/**
 * Check if a chain has a deployed UniswapV3Adapter.
 *
 * @param chain - Chain identifier
 * @returns true if adapter is deployed and configured
 */
export function hasV3Adapter(chain: string): boolean {
  return V3_ADAPTER_ADDRESSES[chain] != null;
}
```

- [ ] **Step 2: Export from config index**

Add re-export to `shared/config/src/index.ts`. Search for the last export line and add after it:

```typescript
export { V3_ADAPTER_ADDRESSES, getV3AdapterAddress, hasV3Adapter } from './v3-adapter-addresses';
```

- [ ] **Step 3: Build shared/config to verify**

Run: `npm run build --workspace=shared/config`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add shared/config/src/v3-adapter-addresses.ts shared/config/src/index.ts
git commit -m "feat(config): add V3 adapter address registry per chain"
```

### Task 2: Route V3 Steps Through Adapter in Flash Loan Strategy

**Files:**
- Modify: `services/execution-engine/src/strategies/flash-loan.strategy.ts`

The key change is in `buildExecuteArbitrageCalldata()` (line ~1347). Currently, V3 steps log a warning and pass through with their original V3 router address (which will fail on-chain because the contract calls `swapExactTokensForTokens()`). After this change, V3 steps get their `router` field replaced with the UniswapV3Adapter address for the chain.

- [ ] **Step 1: Add import at top of file**

After the existing `@arbitrage/config` import block (around line 42-59), add `getV3AdapterAddress` to the config import:

```typescript
import {
  // ... existing imports ...
  getV3AdapterAddress,
} from '@arbitrage/config';
```

- [ ] **Step 2: Replace V3 warning with adapter routing in `buildExecuteArbitrageCalldata()`**

Replace the block at lines ~1367-1375 (the `if (step.isV3 && step.feeTier != null)` warning block) inside the `swapPath.map()` callback. The entire `swapPathTuples` mapping (lines ~1367-1383) should become:

Old code (lines 1367-1383):
```typescript
    const swapPathTuples = swapPath.map(step => {
      if (step.isV3 && step.feeTier != null) {
        this.logger.warn('V3 swap step in flash loan path — on-chain contract only supports V2 routing', {
          tokenIn: step.tokenIn,
          tokenOut: step.tokenOut,
          feeTier: step.feeTier,
          router: step.router,
        });
      }

      return [
        step.router,
        step.tokenIn,
        step.tokenOut,
        step.amountOutMin,
      ];
    });
```

New code:
```typescript
    const swapPathTuples = swapPath.map(step => {
      let router = step.router;

      if (step.isV3) {
        // Route V3 steps through UniswapV3Adapter contract.
        // The adapter wraps V3 exactInputSingle() behind V2 IDexRouter interface,
        // so BaseFlashArbitrage.executeSingleSwap() can call it transparently.
        const adapterAddress = getV3AdapterAddress(this.currentChain ?? '');
        if (adapterAddress) {
          router = adapterAddress;
          this.logger.info('V3 step routed through UniswapV3Adapter', {
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            feeTier: step.feeTier,
            originalRouter: step.router,
            adapterAddress,
          });
        } else {
          this.logger.warn('V3 step detected but no UniswapV3Adapter deployed for chain — using original router (may fail on-chain)', {
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            feeTier: step.feeTier,
            router: step.router,
          });
        }
      }

      return [
        router,
        step.tokenIn,
        step.tokenOut,
        step.amountOutMin,
      ];
    });
```

- [ ] **Step 3: Store chain context for `buildExecuteArbitrageCalldata` access**

The method `buildExecuteArbitrageCalldata()` doesn't currently receive the chain. It's called from `prepareFlashLoanContractTransaction()` which does have `chain`. Add a `currentChain` field that gets set before calling `buildExecuteArbitrageCalldata()`.

At the class field declarations (around line 330), add:

```typescript
  /** Current chain being processed — set by prepareFlashLoanContractTransaction for buildExecuteArbitrageCalldata */
  private currentChain: string | null = null;
```

In `prepareFlashLoanContractTransaction()` (around line 1550, before the `buildExecuteArbitrageCalldata` call), add:

```typescript
    // Set chain context for V3 adapter resolution in buildExecuteArbitrageCalldata
    this.currentChain = chain;
```

**Alternative approach (cleaner):** Instead of a field, pass chain through `ExecuteArbitrageParams`. Add `chain?: string` to the interface (line ~264):

```typescript
export interface ExecuteArbitrageParams {
  asset: string;
  amount: bigint;
  swapPath: SwapStep[];
  minProfit: bigint;
  pool?: string;
  /** Chain identifier for V3 adapter resolution */
  chain?: string;
}
```

Then in `buildExecuteArbitrageCalldata()`, destructure it:
```typescript
  buildExecuteArbitrageCalldata(params: ExecuteArbitrageParams): string {
    const { asset, amount, swapPath, minProfit, pool, chain } = params;
```

And use `chain` directly instead of `this.currentChain`:
```typescript
        const adapterAddress = getV3AdapterAddress(chain ?? '');
```

Then update the call site in `prepareFlashLoanContractTransaction()` (line ~1551):
```typescript
    const calldata = this.buildExecuteArbitrageCalldata({
      asset: opportunity.tokenIn,
      amount: BigInt(opportunity.amountIn),
      swapPath: swapSteps,
      minProfit: minProfitWei,
      pool: poolAddress,
      chain,  // NEW: pass chain for V3 adapter resolution
    });
```

**Use the alternative approach** — it's stateless and threadsafe.

- [ ] **Step 4: Remove the H-002 comment at line ~341**

Remove or update the comment that says V3 adapter was removed:
```typescript
  // Step 3: V3 swap adapter for exactInputSingle encoding
  // H-002: v3SwapAdapter removed — on-chain contract only supports V2 routing
```

Replace with:
```typescript
  // V3 steps routed through on-chain UniswapV3Adapter (resolves H-002)
```

- [ ] **Step 5: Update the H-002 comment block at lines ~1362-1366**

Replace:
```typescript
    // H-002 FIX: On-chain SwapStep struct is V2-only (address router, address tokenIn,
    // address tokenOut, uint256 amountOutMin). SwapHelpers.executeSingleSwap() always
    // calls IDexRouter.swapExactTokensForTokens(). V3 calldata cannot be passed through
    // the current contract architecture. V3 steps are logged as warnings and routed
    // through their V3-compatible router address (which will attempt V2-style call).
```

With:
```typescript
    // On-chain SwapStep struct is V2-only. V3 steps are routed through UniswapV3Adapter
    // contract which wraps V3 exactInputSingle() behind the V2 IDexRouter interface.
    // When no adapter is deployed for a chain, the original router is used (will likely
    // fail on-chain but allows graceful degradation with logging).
```

- [ ] **Step 6: Build execution engine to verify**

Run: `npm run build --workspace=shared/config && npm run build --workspace=shared/core && cd services/execution-engine && npx tsc --noEmit 2>&1 | grep -v TS6305`
Expected: Clean typecheck, no errors.

- [ ] **Step 7: Commit**

```bash
git add services/execution-engine/src/strategies/flash-loan.strategy.ts
git commit -m "feat(execution): route V3 swap steps through UniswapV3Adapter in flash loan path"
```

### Task 3: Include Adapter in Approved Routers

**Files:**
- Modify: `services/execution-engine/src/initialization/strategy-initializer.ts`

The UniswapV3Adapter contract address must be in the `approvedRouters` list so the on-chain flash loan contract accepts it as a valid router. The on-chain contract validates `approvedRouters.contains(step.router)` for each swap step.

- [ ] **Step 1: Add import**

At the top of `strategy-initializer.ts`, add `getV3AdapterAddress` to the config import:

```typescript
import { getV3AdapterAddress } from '@arbitrage/config';
```

- [ ] **Step 2: Add adapter to approved routers in `buildFlashLoanConfig()`**

After the existing approved routers loop (around line 133, just before `return { contractAddresses, approvedRouters, providerOverrides };`), add:

```typescript
    // Include UniswapV3Adapter in approved routers for chains that have it deployed.
    // The adapter must be approved on-chain (addApprovedRouter) AND listed here.
    if (contractAddresses[chain]) {
      const v3Adapter = getV3AdapterAddress(chain);
      if (v3Adapter) {
        if (!approvedRouters[chain]) {
          approvedRouters[chain] = [];
        }
        if (!approvedRouters[chain].includes(v3Adapter)) {
          approvedRouters[chain].push(v3Adapter);
          logger.info('Added UniswapV3Adapter to approved routers', { chain, adapter: v3Adapter });
        }
      }
    }
```

This should go INSIDE the `for (const chain of Object.keys(FLASH_LOAN_PROVIDERS))` loop, after the `if (contractAddresses[chain])` block that handles `approvedRouters` (around line 123-133). The cleanest place is right after the existing block at line 133 that populates approvedRouters, before the closing `}` of the `for` loop.

- [ ] **Step 3: Build and verify**

Run: `cd services/execution-engine && npx tsc --noEmit 2>&1 | grep -v TS6305`
Expected: Clean typecheck.

- [ ] **Step 4: Commit**

```bash
git add services/execution-engine/src/initialization/strategy-initializer.ts
git commit -m "feat(execution): include V3 adapter in approved routers for flash loan contracts"
```

## Chunk 2: Tests

### Task 4: Unit Tests for V3 Execution Path

**Files:**
- Create: `services/execution-engine/__tests__/unit/strategies/v3-execution-path.test.ts`

Tests verify:
1. V3 steps get adapter address substituted when adapter is deployed
2. V3 steps keep original router with warning when no adapter deployed
3. V2 steps are unaffected
4. Mixed V2+V3 paths work correctly
5. `getV3AdapterAddress` returns correct values

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock @arbitrage/config before importing strategy
jest.mock('@arbitrage/config', () => {
  const actual = jest.requireActual('@arbitrage/config') as Record<string, unknown>;
  return {
    ...actual,
    getV3AdapterAddress: jest.fn(),
  };
});

import { getV3AdapterAddress } from '@arbitrage/config';

const mockGetV3AdapterAddress = getV3AdapterAddress as jest.MockedFunction<typeof getV3AdapterAddress>;

// We test buildExecuteArbitrageCalldata via a minimal FlashLoanStrategy instance.
// The method is public so we can call it directly.
import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';

// Shared test constants
const ADAPTER_ADDRESS = '0x1A9838ce19Ae905B4e5941a17891ba180F30F630';
const V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const TOKEN_A = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const TOKEN_B = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
  fatal: jest.fn(),
  trace: jest.fn(),
  silent: jest.fn(),
  level: 'info',
  isLevelEnabled: jest.fn().mockReturnValue(true),
};

function createStrategy(): FlashLoanStrategy {
  return new FlashLoanStrategy(mockLogger as any, {
    contractAddresses: { ethereum: '0x0000000000000000000000000000000000000001' },
    approvedRouters: { ethereum: [V2_ROUTER, V3_ROUTER, ADAPTER_ADDRESS] },
  });
}

describe('V3 Execution Path Wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildExecuteArbitrageCalldata — V3 adapter routing', () => {
    it('substitutes adapter address for V3 steps when adapter is deployed', () => {
      mockGetV3AdapterAddress.mockReturnValue(ADAPTER_ADDRESS);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 3000 },
          { router: V2_ROUTER, tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountOutMin: 1n },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      expect(typeof calldata).toBe('string');
      // The calldata should contain the adapter address (lowercase, without 0x prefix in ABI encoding)
      expect(calldata.toLowerCase()).toContain(ADAPTER_ADDRESS.toLowerCase().slice(2));
      // Should NOT contain the V3 router address (it was substituted)
      expect(calldata.toLowerCase()).not.toContain(V3_ROUTER.toLowerCase().slice(2));
      // Should contain V2 router for the V2 step
      expect(calldata.toLowerCase()).toContain(V2_ROUTER.toLowerCase().slice(2));
      expect(mockLogger.info).toHaveBeenCalledWith(
        'V3 step routed through UniswapV3Adapter',
        expect.objectContaining({ adapterAddress: ADAPTER_ADDRESS }),
      );
    });

    it('keeps original router with warning when no adapter deployed', () => {
      mockGetV3AdapterAddress.mockReturnValue(null);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 3000 },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      // Original V3 router is kept since no adapter available
      expect(calldata.toLowerCase()).toContain(V3_ROUTER.toLowerCase().slice(2));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no UniswapV3Adapter deployed'),
        expect.any(Object),
      );
    });

    it('does not modify V2 steps', () => {
      mockGetV3AdapterAddress.mockReturnValue(ADAPTER_ADDRESS);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V2_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n },
          { router: V2_ROUTER, tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountOutMin: 1n },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      // V2 router should be present, adapter should NOT
      expect(calldata.toLowerCase()).toContain(V2_ROUTER.toLowerCase().slice(2));
      expect(calldata.toLowerCase()).not.toContain(ADAPTER_ADDRESS.toLowerCase().slice(2));
      // No V3-related logging
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'V3 step routed through UniswapV3Adapter',
        expect.any(Object),
      );
    });

    it('handles mixed V2+V3 paths correctly', () => {
      mockGetV3AdapterAddress.mockReturnValue(ADAPTER_ADDRESS);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 500 },
          { router: V2_ROUTER, tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountOutMin: 1n },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      // Adapter for V3 step + original V2 router for V2 step
      expect(calldata.toLowerCase()).toContain(ADAPTER_ADDRESS.toLowerCase().slice(2));
      expect(calldata.toLowerCase()).toContain(V2_ROUTER.toLowerCase().slice(2));
    });

    it('uses empty string chain when chain param not provided', () => {
      mockGetV3AdapterAddress.mockReturnValue(null);
      const strategy = createStrategy();

      strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 3000 },
        ],
        minProfit: 1n,
        // no chain param
      });

      expect(mockGetV3AdapterAddress).toHaveBeenCalledWith('');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/execution-engine && npx jest __tests__/unit/strategies/v3-execution-path.test.ts --no-coverage`
Expected: FAIL — tests reference `chain` param in `ExecuteArbitrageParams` which doesn't exist yet.

- [ ] **Step 3: Verify tests pass after implementation**

After Task 2 implementation is complete, re-run:
Run: `cd services/execution-engine && npx jest __tests__/unit/strategies/v3-execution-path.test.ts --no-coverage`
Expected: All 5 tests PASS.

- [ ] **Step 4: Write config tests**

```typescript
// Add to existing test or create: shared/config/__tests__/unit/v3-adapter-addresses.test.ts

import { getV3AdapterAddress, hasV3Adapter, V3_ADAPTER_ADDRESSES } from '../../src/v3-adapter-addresses';

describe('V3 Adapter Addresses', () => {
  it('returns address for deployed chain', () => {
    expect(getV3AdapterAddress('arbitrumSepolia')).toBe('0x1A9838ce19Ae905B4e5941a17891ba180F30F630');
  });

  it('returns null for chain with no deployment', () => {
    expect(getV3AdapterAddress('ethereum')).toBeNull();
    expect(getV3AdapterAddress('bsc')).toBeNull();
  });

  it('returns null for unknown chain', () => {
    expect(getV3AdapterAddress('unknown_chain')).toBeNull();
  });

  it('hasV3Adapter returns true for deployed chain', () => {
    expect(hasV3Adapter('arbitrumSepolia')).toBe(true);
  });

  it('hasV3Adapter returns false for undeployed chain', () => {
    expect(hasV3Adapter('ethereum')).toBe(false);
    expect(hasV3Adapter('nonexistent')).toBe(false);
  });

  it('registry has entries for all expected chains', () => {
    const expectedChains = [
      'arbitrumSepolia', 'ethereum', 'arbitrum', 'base', 'optimism',
      'polygon', 'bsc', 'avalanche', 'fantom', 'linea', 'zksync',
      'blast', 'scroll', 'mantle', 'mode',
    ];
    for (const chain of expectedChains) {
      expect(chain in V3_ADAPTER_ADDRESSES).toBe(true);
    }
  });
});
```

- [ ] **Step 5: Run config tests**

Run: `cd shared/config && npx jest __tests__/unit/v3-adapter-addresses.test.ts --no-coverage`
Expected: All 6 tests PASS.

- [ ] **Step 6: Run full execution engine test suite to verify no regressions**

Run: `cd services/execution-engine && npx jest --no-coverage --maxWorkers=2 2>&1 | tail -20`
Expected: All existing tests pass. No regressions.

- [ ] **Step 7: Commit tests**

```bash
git add services/execution-engine/__tests__/unit/strategies/v3-execution-path.test.ts shared/config/__tests__/unit/v3-adapter-addresses.test.ts
git commit -m "test(execution): add V3 adapter routing tests for flash loan strategy"
```

### Task 5: Typecheck Full Build

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: Clean build across all packages.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No new type errors.

---

## Post-Implementation Notes

### On-Chain Prerequisites (Not Part of This Plan)

For V3 routing to work end-to-end on a chain, two on-chain steps are required:

1. **Deploy UniswapV3Adapter** to the target chain using `contracts/scripts/deploy-v3-adapter.ts`
2. **Approve the adapter** as a router in the flash loan contract: call `addApprovedRouter(adapterAddress)` on the FlashLoanArbitrage contract

Until these are done for a chain, the off-chain code will log a warning and pass through the original V3 router (which will fail the on-chain `approvedRouters.contains()` check, resulting in a reverted transaction rather than silent failure).

### Deployment Priority (By Profitability Audit Sweet Spot)

1. **Arbitrum** — highest V3 liquidity (Uniswap V3), already has testnet adapter
2. **Base** — Uniswap V3 dominant
3. **Polygon** — Uniswap V3 + QuickSwap V3 (Algebra)
4. **BSC** — PancakeSwap V3
5. **Ethereum** — high gas, deploy last

### Success Metrics

- [ ] V3 swap steps in flash loan calldata use adapter address (verified by unit test)
- [ ] V2 steps remain unaffected (verified by unit test)
- [ ] No regressions in existing test suite
- [ ] Adapter address appears in approved routers for chains where deployed
- [ ] Clean typecheck across all packages
