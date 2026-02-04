# Enhancement Research Report: Local Development Simulation Modes

**Date**: 2026-02-04
**Enhancement Areas**: Developer Experience, Testing Coverage, Strategy Validation
**Hot-Path Impact**: NO - Simulation modes are for development/testing only

---

## Executive Summary

This research analyzes the current SIMULATION_MODE and EXECUTION_SIMULATION_MODE implementations and identifies gaps that prevent comprehensive local testing of all blockchains and execution strategies.

**Key Findings**:
1. **Gap 1**: SimulatedOpportunity lacks `type` field - cannot generate cross-chain, flash-loan, triangular, or quadrilateral opportunities
2. **Gap 2**: No cross-chain price differential simulation between chains
3. **Gap 3**: Execution simulation ignores opportunity type - always uses SimulationStrategy
4. **Gap 4**: Limited token pair coverage per chain (missing chain-specific tokens)
5. **Gap 5**: No Solana-specific opportunity simulation (program account changes vs Sync events)

**Recommended Solutions**:
- Extend SimulatedOpportunity type field
- Add cross-chain opportunity generator
- Create strategy-specific simulation behaviors
- Expand token pairs with chain-specific assets

---

## 1. Current State Analysis

### 1.1 SIMULATION_MODE (Price Feed Simulation)

<research_thinking>
### Phase 1: Current State Deep Dive

**Investigation Summary**:

1. **PriceSimulator Class** (simulation-mode.ts:187-341)
   - Generates price updates with random walk volatility
   - Covers all 11 chains across 4 partitions
   - Emits `priceUpdate` events with SimulatedPriceUpdate structure
   - Creates arbitrage opportunities by adding spread to random DEX prices

2. **ChainSimulator Class** (simulation-mode.ts:440-685)
   - Generates Sync events matching real DEX format
   - Reserve-based price calculation (AMM math)
   - Detects intra-chain opportunities between DEXes
   - Emits: `syncEvent`, `opportunity`, `blockUpdate`

3. **Simulated Opportunity Structure** (simulation-mode.ts:386-400)
   ```typescript
   interface SimulatedOpportunity {
     id: string;
     chain: string;           // Single chain only
     buyDex: string;
     sellDex: string;
     tokenPair: string;
     buyPrice: number;
     sellPrice: number;
     profitPercentage: number;
     estimatedProfitUsd: number;
     confidence: number;
     timestamp: number;
     expiresAt: number;
     isSimulated: true;
   }
   ```

**Design Rationale**:
- Simple intra-chain arbitrage focus for MVP
- Reserve-based simulation matches real DEX behavior
- 5-10% arbitrage chance creates realistic opportunity frequency

**Known Limitations**:
- No `type` field → all opportunities treated as intra-chain
- No `buyChain`/`sellChain` fields → cannot simulate cross-chain
- No `useFlashLoan` field → cannot test flash loan routing
- No multi-hop path support → cannot test triangular/quadrilateral
- No Solana program account simulation

</research_thinking>

#### Current Implementation

| Component | File | Key Metrics |
|-----------|------|-------------|
| PriceSimulator | `simulation-mode.ts:187-341` | 11 chains, 13 pairs, 2 DEXes/chain |
| ChainSimulator | `simulation-mode.ts:440-685` | Reserve-based, Sync event format |
| SimulatedOpportunity | `simulation-mode.ts:386-400` | Intra-chain only, no type field |

#### Chains Covered
```
P1 Asia-Fast:    bsc, polygon, avalanche, fantom
P2 L2-Turbo:     arbitrum, optimism, base
P3 High-Value:   ethereum, zksync, linea
P4 Solana:       solana (simplified, no Sync events)
```

#### Token Pairs (13 total)
- Stablecoins: WETH/USDC, WETH/USDT, WBTC/WETH, WBTC/USDC
- Chain-native: WBNB/BUSD, WBNB/USDT, MATIC/USDC, AVAX/USDC, FTM/USDC, SOL/USDC
- DeFi: LINK/WETH, ARB/WETH, OP/WETH

---

### 1.2 EXECUTION_SIMULATION_MODE (Transaction Simulation)

<research_thinking>
### Phase 1: Execution Simulation Deep Dive

**Investigation Summary**:

1. **SimulationStrategy** (simulation.strategy.ts:36-160)
   - Configurable success rate (default: 85%)
   - Configurable latency simulation (default: 500ms)
   - Profit variance (±20%)
   - Generates simulated tx hashes
   - Updates ctx.stats for metrics consistency

2. **Strategy Selection** (strategy-factory.ts:230-306)
   - Priority 1: Simulation mode → SimulationStrategy (OVERRIDES ALL)
   - Priority 2: flash-loan/triangular/quadrilateral → FlashLoanStrategy
   - Priority 3: cross-chain → CrossChainStrategy
   - Priority 4: intra-chain → IntraChainStrategy

**Design Rationale**:
- SimulationStrategy bypasses real strategies when enabled
- Consistent result format with real strategies
- Stats tracking remains accurate

**Critical Gap Identified**:
When EXECUTION_SIMULATION_MODE=true:
- ALL opportunities → SimulationStrategy (regardless of type)
- FlashLoanStrategy NEVER tested
- CrossChainStrategy NEVER tested
- Strategy-specific logic (bridge recovery, flash loan fees) NOT exercised

This defeats the purpose of comprehensive integration testing!

</research_thinking>

#### Current Implementation

| Component | File | Key Metrics |
|-----------|------|-------------|
| SimulationStrategy | `simulation.strategy.ts:36-160` | 85% success, 500ms latency |
| StrategyFactory | `strategy-factory.ts:230-306` | SimulationMode overrides all |

#### Configuration (from .env)
```bash
EXECUTION_SIMULATION_MODE=false
EXECUTION_SIMULATION_SUCCESS_RATE=0.85
EXECUTION_SIMULATION_LATENCY_MS=500
EXECUTION_SIMULATION_GAS_USED=200000
EXECUTION_SIMULATION_GAS_COST_MULTIPLIER=0.1
EXECUTION_SIMULATION_PROFIT_VARIANCE=0.2
EXECUTION_SIMULATION_LOG=true
```

---

## 2. Gap Analysis

### Gap 1: SimulatedOpportunity Missing Fields

**Current Structure**:
```typescript
interface SimulatedOpportunity {
  id: string;
  chain: string;        // ← Single chain
  buyDex: string;
  sellDex: string;
  // Missing: type, buyChain, sellChain, useFlashLoan, hops, path
}
```

**Required for Full Coverage**:
```typescript
interface SimulatedOpportunity {
  id: string;
  type: 'intra-chain' | 'cross-chain' | 'flash-loan' | 'triangular' | 'quadrilateral';
  chain: string;         // For intra-chain
  buyChain?: string;     // For cross-chain
  sellChain?: string;    // For cross-chain
  buyDex: string;
  sellDex: string;
  useFlashLoan?: boolean;
  // For triangular/quadrilateral:
  hops?: number;
  path?: string[];       // Token path
  intermediateTokens?: string[];
}
```

**Impact**: Without these fields, strategy routing cannot be tested.

---

### Gap 2: No Cross-Chain Opportunity Generation

**Current State**: ChainSimulator only detects opportunities within a single chain.

**Required**: CrossChainSimulator that:
1. Maintains price state across multiple chains
2. Detects price differentials between chains for same token
3. Considers bridge costs/fees
4. Generates opportunities with `buyChain !== sellChain`

**Example Scenario**:
- ETH price on Arbitrum: $3,200
- ETH price on Optimism: $3,210
- Bridge cost: $5
- Profit: $10 - $5 = $5 per ETH (0.15%)

---

### Gap 3: SimulationStrategy Overrides All

**Current Behavior** (strategy-factory.ts:232-241):
```typescript
// Priority 1: Simulation mode overrides everything
if (this.isSimulationMode) {
  return {
    type: 'simulation',
    strategy: this.strategies.simulation,  // ALWAYS this
    reason: 'Simulation mode is active',
  };
}
```

**Problem**: Real strategies never execute in simulation mode.

**Solution Options**:

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A. Pass-through mode** | Let real strategies run with dry-run provider | Tests real logic | Needs mock provider |
| **B. Strategy-aware simulation** | SimulationStrategy mimics per-strategy behavior | Self-contained | Duplicates logic |
| **C. Hybrid mode** | Use real strategy selection, simulate tx only | Best coverage | More complex |

**Recommendation**: Option C (Hybrid mode) - Use real strategy selection but mock the final transaction submission.

---

### Gap 4: Limited Token Coverage

**Current Coverage** (13 pairs):
- Missing chain-specific governance tokens (ARB, OP only on their chains)
- Missing LST tokens on each chain
- Missing meme tokens (PEPE, SHIB, BONK)
- Missing Solana-specific tokens (JUP, RAY, ORCA properly)

**Recommended Additions** (per chain):

| Chain | Missing Tokens | Priority |
|-------|---------------|----------|
| Ethereum | stETH, rETH, PEPE, SHIB | HIGH |
| Arbitrum | GMX, MAGIC, PENDLE | MEDIUM |
| Optimism | VELO, sUSD | MEDIUM |
| Base | AERO, cbETH | MEDIUM |
| BSC | CAKE, XVS | MEDIUM |
| Polygon | stMATIC, QUICK | MEDIUM |
| Solana | JTO, PYTH, mSOL, jitoSOL, BONK, WIF | HIGH |

---

### Gap 5: Solana Simulation Incomplete

**Current State** (chain-instance.ts:509-521):
- Uses "simplified simulation" for Solana
- Generates price updates but NOT program account changes
- No Raydium/Orca pool simulation

**Required for Full Coverage**:
- Simulate Raydium AMM account state
- Simulate Orca Whirlpool tick arrays
- Support Jupiter aggregation simulation
- Generate Solana-native opportunity format

---

## 3. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| **Mock Provider Pattern** | Hardhat, Foundry | + Tests real contract logic<br>+ High fidelity | - Requires EVM fork<br>- Slow | 5 days |
| **Simulation Service** | Tenderly, Alchemy | + Cloud-based<br>+ Real state | - API dependency<br>- Cost | 2 days |
| **Strategy Stubs** | Trading systems | + Fast<br>+ Isolated | - Lower fidelity<br>- Maintenance | 3 days |
| **Event Replay** | MEV bots, HFT | + Real data<br>+ Reproducible | - Data management<br>- Storage | 4 days |

---

## 4. Recommended Solutions

### Solution S1: Extended SimulatedOpportunity Type

**Approach**: Add missing fields to SimulatedOpportunity interface
**Confidence**: HIGH (95%)
**Effort**: 0.5 days
**Expected Impact**: Enable strategy routing tests

```typescript
// simulation-mode.ts - Enhanced interface
export interface SimulatedOpportunity {
  id: string;
  // Strategy routing fields
  type: 'intra-chain' | 'cross-chain' | 'flash-loan' | 'triangular' | 'quadrilateral';

  // Chain information
  chain: string;           // Primary chain (for intra-chain)
  buyChain: string;        // Source chain (for cross-chain)
  sellChain: string;       // Destination chain (for cross-chain)

  // DEX information
  buyDex: string;
  sellDex: string;
  tokenPair: string;

  // Execution hints
  useFlashLoan: boolean;
  bridgeProtocol?: 'stargate' | 'across' | 'native';

  // Multi-hop support
  hops?: number;
  path?: string[];         // For triangular: ['WETH', 'USDC', 'WBTC', 'WETH']

  // Pricing
  buyPrice: number;
  sellPrice: number;
  profitPercentage: number;
  estimatedProfitUsd: number;

  // Metadata
  confidence: number;
  timestamp: number;
  expiresAt: number;
  isSimulated: true;
}
```

---

### Solution S2: Cross-Chain Opportunity Generator

**Approach**: New class that maintains cross-chain price state
**Confidence**: HIGH (85%)
**Effort**: 2 days
**Expected Impact**: Enable cross-chain strategy testing

```typescript
// simulation-mode.ts - New class
export class CrossChainSimulator extends EventEmitter {
  private chainPrices: Map<string, Map<string, number>> = new Map();
  private bridgeCosts: Map<string, number>;

  constructor(config: CrossChainSimulatorConfig) {
    // Initialize price state per chain
    // Track bridge costs (Stargate, Across)
  }

  start(): void {
    // Update prices per chain
    // Detect cross-chain differentials
    // Emit opportunities when profitable after bridge costs
  }

  private detectCrossChainOpportunity(
    token: string,
    sourceChain: string,
    destChain: string
  ): SimulatedOpportunity | null {
    const sourcePrice = this.chainPrices.get(sourceChain)?.get(token);
    const destPrice = this.chainPrices.get(destChain)?.get(token);
    const bridgeCost = this.bridgeCosts.get(`${sourceChain}-${destChain}`);

    if (!sourcePrice || !destPrice || !bridgeCost) return null;

    const profit = (destPrice - sourcePrice) - bridgeCost;
    if (profit > MIN_CROSS_CHAIN_PROFIT) {
      return {
        type: 'cross-chain',
        buyChain: sourceChain,
        sellChain: destChain,
        bridgeProtocol: 'stargate',
        // ... rest of fields
      };
    }
    return null;
  }
}
```

---

### Solution S3: Multi-Hop Opportunity Generator

**Approach**: Generate triangular/quadrilateral opportunities
**Confidence**: MEDIUM (75%)
**Effort**: 1.5 days
**Expected Impact**: Enable flash loan strategy testing

```typescript
// simulation-mode.ts - Extension
private generateMultiHopOpportunity(
  chain: string,
  dex: string,
  hops: 3 | 4
): SimulatedOpportunity | null {
  // Select random tokens for path
  const tokens = this.selectRandomPath(chain, hops);
  // tokens = ['WETH', 'USDC', 'WBTC', 'WETH'] for triangular

  // Calculate circular profit (including fees per hop)
  const { profit, path } = this.calculatePathProfit(chain, dex, tokens);

  if (profit > MIN_MULTI_HOP_PROFIT) {
    return {
      type: hops === 3 ? 'triangular' : 'quadrilateral',
      chain,
      buyDex: dex,
      sellDex: dex,  // Same DEX for multi-hop
      useFlashLoan: true,
      hops,
      path: tokens,
      profitPercentage: profit * 100,
      // ... rest
    };
  }
  return null;
}
```

---

### Solution S4: Hybrid Execution Mode

**Approach**: Real strategy selection with mocked transaction submission
**Confidence**: MEDIUM (70%)
**Effort**: 3 days
**Expected Impact**: Full strategy logic coverage

```typescript
// New mode: EXECUTION_HYBRID_MODE
// - Real strategy selection (resolve())
// - Real pre-execution logic (validation, simulation calls)
// - Mocked transaction submission

// strategy-factory.ts modification
resolve(opportunity: ArbitrageOpportunity): StrategyResolution {
  // REMOVE this block when HYBRID mode:
  // if (this.isSimulationMode) { ... }

  // Normal strategy resolution continues
  // ...
}

// base.strategy.ts modification
protected async submitTransaction(...): Promise<TransactionResponse> {
  if (this.isHybridMode) {
    // Log what WOULD be submitted
    this.logger.info('HYBRID: Would submit transaction', { ... });
    return this.createMockTransactionResponse();
  }

  // Real submission
  return wallet.sendTransaction(tx);
}
```

---

### Solution S5: Chain-Specific Token Expansion

**Approach**: Add missing tokens per chain
**Confidence**: HIGH (90%)
**Effort**: 1 day
**Expected Impact**: More realistic simulation coverage

```typescript
// simulation-mode.ts - Extended pairs per chain
const CHAIN_SPECIFIC_PAIRS: Record<string, string[][]> = {
  ethereum: [
    ['stETH', 'WETH'], ['rETH', 'WETH'], ['cbETH', 'WETH'],
    ['PEPE', 'WETH'], ['SHIB', 'WETH'],
  ],
  arbitrum: [
    ['ARB', 'WETH'], ['GMX', 'WETH'], ['MAGIC', 'WETH'],
    ['PENDLE', 'WETH'],
  ],
  optimism: [
    ['OP', 'WETH'], ['VELO', 'WETH'], ['sUSD', 'USDC'],
  ],
  base: [
    ['AERO', 'WETH'], ['cbETH', 'WETH'],
  ],
  bsc: [
    ['CAKE', 'WBNB'], ['XVS', 'WBNB'],
  ],
  polygon: [
    ['stMATIC', 'WMATIC'], ['QUICK', 'WMATIC'],
  ],
  solana: [
    ['SOL', 'USDC'], ['JUP', 'SOL'], ['RAY', 'SOL'],
    ['ORCA', 'SOL'], ['BONK', 'SOL'], ['WIF', 'SOL'],
    ['JTO', 'SOL'], ['PYTH', 'SOL'], ['mSOL', 'SOL'],
    ['jitoSOL', 'SOL'],
  ],
};
```

---

### Solution S6: Solana Account Simulation

**Approach**: Proper Solana DEX pool simulation
**Confidence**: MEDIUM (65%)
**Effort**: 3 days
**Expected Impact**: Complete Solana testing coverage

```typescript
// solana-simulator.ts - New file
export class SolanaPoolSimulator extends EventEmitter {
  private raydiumPools: Map<string, RaydiumAmmState> = new Map();
  private orcaPools: Map<string, OrcaWhirlpoolState> = new Map();

  // Simulate Raydium AMM state changes
  private updateRaydiumPool(pool: string): void {
    const state = this.raydiumPools.get(pool);
    // Apply volatility to token_a_amount and token_b_amount
    // Emit account change event
    this.emit('accountChange', {
      pubkey: pool,
      data: this.serializeRaydiumState(state),
    });
  }

  // Simulate Orca Whirlpool tick updates
  private updateOrcaPool(pool: string): void {
    const state = this.orcaPools.get(pool);
    // Update current_tick_index
    // Update liquidity at tick
    this.emit('accountChange', {
      pubkey: pool,
      data: this.serializeOrcaState(state),
    });
  }
}
```

---

## 5. Implementation Plan

### Phase 1: Quick Wins (1-2 days)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | Extend SimulatedOpportunity interface (S1) | 0.5 day | 95% | None | Unit test type checking |
| 2 | Add chain-specific tokens (S5) | 0.5 day | 90% | None | Integration test price generation |
| 3 | Add opportunity type generation to ChainSimulator | 0.5 day | 90% | Task 1 | Unit test opportunity types |

### Phase 2: Core Improvements (3-5 days)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 4 | Implement CrossChainSimulator (S2) | 2 days | 85% | Task 1 | Integration test cross-chain detection |
| 5 | Add multi-hop opportunity generation (S3) | 1.5 days | 75% | Task 1 | Unit test path calculation |
| 6 | Implement hybrid execution mode (S4) | 2 days | 70% | None | E2E test with all strategies |

### Phase 3: Advanced (5+ days)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 7 | Implement SolanaPoolSimulator (S6) | 3 days | 65% | None | Unit test account serialization |
| 8 | Add event replay from historical data | 3 days | 60% | External data | Replay test with known outcomes |

---

## 6. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Extended interface breaks existing tests | LOW | MEDIUM | Add new fields as optional initially |
| Cross-chain simulation oversimplifies bridge delays | MEDIUM | LOW | Document as limitation, add delay config |
| Hybrid mode introduces race conditions | MEDIUM | HIGH | Add feature flag, thorough testing |
| Solana simulation accuracy insufficient | HIGH | MEDIUM | Compare against real pool state periodically |
| Maintenance burden increases significantly | MEDIUM | MEDIUM | Keep simulation code modular, well-documented |

---

## 7. Success Metrics

### Coverage Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Strategy types testable | 1 (intra-chain) | 5 (all) | Count distinct opportunity.type values generated |
| Chains with full simulation | 10 EVM | 11 (+ Solana proper) | SolanaPoolSimulator coverage |
| Token pairs simulated | 13 | 50+ | Count unique pairs across all chains |
| Cross-chain routes testable | 0 | 8+ | Count unique chain pairs generated |

### Quality Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Simulation vs real divergence | Unknown | <10% | Compare simulation results to historical production |
| Test coverage of execution engine | ~70% | >90% | Jest coverage report |
| E2E test scenarios | Intra-chain only | All strategies | Test file count |

---

## 8. ADR Recommendation

### New ADR Needed: ADR-026: Simulation Mode Architecture

**Context**: Current simulation modes only cover intra-chain scenarios. Comprehensive local testing requires coverage of all execution strategies.

**Decision Areas**:
- Simulation vs hybrid execution mode
- Cross-chain opportunity generation strategy
- Solana simulation approach (account-based vs price-based)
- Token coverage requirements per chain

---

## 9. Constraint Conflict Resolution

### Conflict: Simulation Fidelity vs. Simplicity

<constraint_analysis>
**Conflicting Constraints**:
- **Constraint A**: High-fidelity simulation (matches real execution closely)
- **Constraint B**: Simple to maintain and understand

**Resolution**: Tiered approach
- Tier 1 (Default): Simple price-based simulation - current level
- Tier 2 (Enhanced): Strategy-aware simulation with extended opportunity types
- Tier 3 (High-fidelity): Hybrid mode with real strategy logic, mocked tx

**Trade-offs Accepted**:
- Simple mode may miss edge cases
- High-fidelity mode has higher maintenance cost
- Developer chooses appropriate tier based on testing needs
</constraint_analysis>

---

## 10. Summary

### Immediate Actions (This Week)

1. **Extend SimulatedOpportunity** with `type`, `buyChain`, `sellChain`, `useFlashLoan` fields
2. **Add chain-specific token pairs** to simulation configuration
3. **Generate varied opportunity types** (intra-chain, flash-loan, triangular)

### Short-Term (Next 2 Weeks)

4. **Implement CrossChainSimulator** for cross-chain opportunity generation
5. **Add multi-hop path calculation** for triangular/quadrilateral opportunities
6. **Create hybrid execution mode** for full strategy coverage

### Medium-Term (Next Month)

7. **Implement SolanaPoolSimulator** for proper Solana coverage
8. **Add event replay capability** for reproducible testing
9. **Create comprehensive E2E test suite** using enhanced simulation

---

## References

- `shared/core/src/simulation-mode.ts` - Current simulation implementation
- `services/execution-engine/src/strategies/` - Execution strategies
- `services/execution-engine/src/strategies/strategy-factory.ts` - Strategy routing
- `docs/architecture/adr/ADR-003-partitioned-detectors.md` - Chain partition design
- `docs/architecture/adr/ADR-020-flash-loan.md` - Flash loan strategy

---

## Verification Checklist

<verification>
**Current State Claims Check**:
- [x] SimulatedOpportunity interface verified (simulation-mode.ts:386-400)
- [x] Strategy routing priority confirmed (strategy-factory.ts:230-306)
- [x] Chain coverage verified (simulation-mode.ts:72-80)
- [x] Token pairs documented (simulation-mode.ts:82-99)

**Industry Best Practices Verification**:
- [x] Mock provider pattern: Standard in Hardhat/Foundry
- [x] Event replay: Common in trading systems for backtesting
- [x] Strategy stubs: Standard pattern for isolated testing

**Recommendation Justification**:
- [x] Each solution linked to specific gap
- [x] Effort estimates include testing time
- [x] Risk mitigations are actionable
- [x] Success metrics are measurable
</verification>
