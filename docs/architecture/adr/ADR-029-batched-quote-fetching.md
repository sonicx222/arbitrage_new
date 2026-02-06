# ADR-029: Batched Quote Fetching via MultiPathQuoter Contract

**Status**: Accepted
**Date**: 2026-02-06
**Deciders**: Development Team
**Related**: [ADR-016 Transaction Simulation](ADR-016-transaction-simulation.md), [ADR-020 Flash Loan Integration](ADR-020-flash-loan.md)

---

## Context

### Problem Statement

The FlashLoanStrategy currently fetches swap quotes sequentially by calling each DEX router's `getAmountsOut()` function individually. For a typical 2-hop arbitrage path (buy on DEX A, sell on DEX B), this results in:

- **2 sequential RPC calls** to different router contracts
- **~50-100ms per call** (network latency + RPC provider processing)
- **Total latency: 100-200ms** for profit calculation

In MEV-competitive environments, this latency directly impacts:
1. **Opportunity freshness** - Stale quotes lead to failed executions
2. **Gas cost accuracy** - Delayed execution means different gas prices
3. **Profitability analysis** - Prices move during the 200ms window

### Current Data Flow

```
Opportunity Detected
    ↓
FlashLoanStrategy.calculateExpectedProfitOnChain()
    ↓
For each hop in path:
    RPC Call 1: router1.getAmountsOut(amountIn, [tokenA, tokenB])  [~50-100ms]
    RPC Call 2: router2.getAmountsOut(amountOut1, [tokenB, tokenA]) [~50-100ms]
    ↓
Calculate profit from quotes
    ↓
Total Latency: 100-200ms
```

### Research Findings

Analysis from [FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md](../../research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md) shows:

| Metric | Current (Sequential) | Target (Batched) | Improvement |
|--------|---------------------|------------------|-------------|
| RPC Calls | N (one per hop) | 1 (batched) | N→1 reduction |
| Latency (2-hop) | 100-200ms | 30-50ms | 75% faster |
| Latency (3-hop) | 150-300ms | 30-50ms | 83% faster |
| RPC Cost | $0.001 × N | $0.001 | N→1 reduction |

---

## Decision

We will deploy the **MultiPathQuoter contract** to Ethereum, Arbitrum, and Base, and integrate the **BatchQuoterService** into FlashLoanStrategy to batch multiple `getAmountsOut()` calls into a single RPC request.

### Key Architectural Components

#### 1. MultiPathQuoter Contract (Already Exists ✅)

**Location**: `contracts/src/MultiPathQuoter.sol`

A stateless, pure-view contract that batches multiple DEX router queries:

```solidity
function getBatchedQuotes(QuoteRequest[] calldata requests)
    external
    view
    returns (QuoteResult[] memory results)
```

**Key Features**:
- **Gas-optimized**: Pre-allocates path arrays, reuses across iterations
- **Error handling**: Try-catch per quote (one failure doesn't block others)
- **Chained quotes**: Support for amountIn=0 to chain from previous output
- **Arbitrage simulation**: `simulateArbitragePath()` calculates full path profit

#### 2. BatchQuoterService (Already Exists ✅)

**Location**: `services/execution-engine/src/services/simulation/batch-quoter.service.ts`

A TypeScript service layer that:
- Auto-resolves MultiPathQuoter address from chain registry
- Gracefully falls back to sequential quotes if contract not deployed
- Tracks metrics (latency, success rate, fallback usage)
- Provides timeout protection (5s default)

#### 3. Integration Pattern

**Opt-in via Feature Flag**:
```typescript
// FlashLoanStrategy uses BatchQuoterService only if:
1. Feature flag enabled (FEATURE_BATCHED_QUOTER=true)
2. Contract deployed for chain
3. No errors during batched call

// Otherwise: Falls back to existing sequential logic
```

### Enhanced Data Flow

```
Opportunity Detected
    ↓
FlashLoanStrategy.calculateExpectedProfitWithBatching()
    ↓
IF batchedQuoter.isAvailable():
    Single RPC Call: MultiPathQuoter.simulateArbitragePath([
        {router: router1, tokenIn: A, tokenOut: B, amountIn: 100},
        {router: router2, tokenIn: B, tokenOut: A, amountIn: 0}
    ]) [~30-50ms]
ELSE:
    Fallback to sequential quotes [~100-200ms]
    ↓
Total Latency: 30-50ms (with batching) or 100-200ms (fallback)
```

---

## Consequences

### Positive

1. **75-83% Latency Reduction**
   - 2-hop paths: 100-200ms → 30-50ms
   - 3-hop paths: 150-300ms → 30-50ms
   - More accurate profit calculations

2. **RPC Cost Reduction**
   - N sequential calls → 1 batched call
   - ~70% cost savings for 3-hop paths

3. **Zero Breaking Changes**
   - Feature flag defaults to OFF
   - Automatic fallback to sequential quotes
   - No changes to existing execution flow

4. **Chain-Agnostic**
   - Works on any EVM chain
   - Easy to deploy to additional chains
   - Auto-discovery via configuration registry

5. **Resilient**
   - Multiple fallback layers
   - Timeout protection (5s default)
   - Graceful degradation on errors

### Negative

1. **Deployment Overhead**
   - Requires contract deployment to each chain (~$30-60 total for 3 chains)
   - Deployment addresses must be registered in configuration

2. **Additional Code Paths**
   - Strategy now has two paths: batched + sequential fallback
   - Slightly increased complexity (mitigated by tests)

3. **Dependency on Contract Availability**
   - If contract not deployed, falls back to sequential
   - Contract address must be in registry for auto-discovery

### Neutral

1. **No Performance Impact on Hot Path**
   - Batched quoting only used in cold path (profit simulation)
   - Opportunity detection (<50ms) remains unchanged

2. **Metrics Tracking**
   - BatchQuoterService tracks usage metrics
   - Can monitor latency improvement in production

---

## Implementation Details

### Configuration

**Registry** (`contracts/deployments/addresses.ts`):
```typescript
export const MULTI_PATH_QUOTER_ADDRESSES: Record<string, string> = {
  ethereum: '0x...', // Deployed address
  arbitrum: '0x...', // Deployed address
  base: '0x...', // Deployed address
};
```

**Feature Flag** (`shared/config/src/service-config.ts`):
```typescript
export const FEATURE_FLAGS = {
  useBatchedQuoter: process.env.FEATURE_BATCHED_QUOTER === 'true',
};
```

### Strategy Integration

**FlashLoanStrategy Enhancement**:
```typescript
// New method (added to flash-loan.strategy.ts)
private async calculateExpectedProfitWithBatching(
  opportunity: ArbitrageOpportunity,
  chain: string,
  ctx: StrategyContext
): Promise<{ expectedProfit: bigint; flashLoanFee: bigint } | null> {
  // Check feature flag
  if (!FEATURE_FLAGS.useBatchedQuoter) {
    return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
  }

  // Get or create BatchQuoterService
  const batchQuoter = this.getBatchQuoterService(chain, ctx);
  if (!batchQuoter) {
    return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
  }

  try {
    // Build quote requests and simulate via BatchQuoterService
    const result = await batchQuoter.simulateArbitragePath(...);

    if (!result.allSuccess) {
      // Fallback to sequential
      return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
    }

    return {
      expectedProfit: result.expectedProfit,
      flashLoanFee: this.calculateFlashLoanFee(...),
    };
  } catch (error) {
    // Fallback to sequential
    this.logger.warn('BatchQuoter error, using fallback', { error, chain });
    return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
  }
}
```

### Deployment Process

**Phase 1: Testnet Validation**
```bash
# Deploy to Sepolia
npx hardhat run scripts/deploy-multi-path-quoter.ts --network sepolia

# Validate
# - Call getBatchedQuotes() manually
# - Verify gas usage
# - Test error handling
```

**Phase 2: Mainnet Deployment**
```bash
# Deploy to 3 chains
npx hardhat run scripts/deploy-multi-path-quoter.ts --network ethereum
npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrum
npx hardhat run scripts/deploy-multi-path-quoter.ts --network base

# Verify on block explorers
npx hardhat verify --network ethereum <address>
```

**Phase 3: Gradual Rollout**
1. Deploy with `FEATURE_BATCHED_QUOTER=false` (feature disabled)
2. Enable for Base first (lowest stakes)
3. Monitor metrics for 1 hour
4. Enable for Arbitrum
5. Enable for Ethereum

### Rollback Plan

**Instant Rollback**:
```bash
# Disable feature flag (no code deploy needed)
export FEATURE_BATCHED_QUOTER=false

# Restart services
npm run dev:stop
npm run dev:execution:fast
```

**Code Rollback** (if needed):
```typescript
// Temporary patch - force fallback
private async calculateExpectedProfitWithBatching(...) {
  return await this.calculateExpectedProfitOnChain(...); // Skip batching
}
```

---

## Alternatives Considered

### Alternative 1: Keep Sequential Quoting

**Pros**:
- No additional deployment
- Simpler code (no branching)
- Works today

**Cons**:
- 100-200ms latency bottleneck remains
- Higher RPC costs (N calls vs 1)
- Less competitive in MEV scenarios

**Decision**: Rejected - latency improvement justifies deployment effort

---

### Alternative 2: Client-Side Parallel RPC Calls

**Approach**: Use `Promise.all()` to fetch quotes in parallel
```typescript
const [quote1, quote2] = await Promise.all([
  router1.getAmountsOut(...),
  router2.getAmountsOut(...)
]);
```

**Pros**:
- No contract deployment needed
- Slightly faster than sequential

**Cons**:
- Still 2 RPC calls (network latency × 2)
- Cannot chain quotes (amountIn depends on previous amountOut)
- Still ~100ms best case (limited by slowest call)

**Decision**: Rejected - doesn't solve the fundamental latency problem

---

### Alternative 3: Off-Chain Quote Aggregation Service

**Approach**: Deploy a centralized service that caches and aggregates quotes

**Pros**:
- Could cache quotes for multiple strategies
- Potentially faster than on-chain calls

**Cons**:
- Introduces centralization point of failure
- Cache invalidation complexity
- Stale quotes risk in MEV environment
- Additional infrastructure to maintain

**Decision**: Rejected - complexity outweighs benefits, on-chain is trustless

---

## Success Metrics

### Performance Targets

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Avg Quote Latency (2-hop) | 100-200ms | <50ms | `BatchQuoterMetrics.averageLatencyMs` |
| Avg Quote Latency (3-hop) | 150-300ms | <50ms | `BatchQuoterMetrics.averageLatencyMs` |
| Fallback Rate | 0% (no batching) | <10% | `fallbackUsed / totalQuotes` |
| RPC Calls per Quote | 2-3 | 1 | Direct measurement |
| Profit Accuracy | ±2% | ±2% (maintain) | Compare simulated vs actual |

### Acceptance Criteria

**Must Have** ✅:
- [x] MultiPathQuoter deployed to ethereum, arbitrum, base
- [ ] BatchQuoterService integrated into FlashLoanStrategy
- [ ] Feature flag functional (on/off toggle)
- [ ] Fallback to sequential quoting works
- [ ] Unit tests pass (>85% coverage)
- [ ] Contracts verified on block explorers

**Nice to Have** 🎯:
- [ ] Deploy to additional chains (polygon, optimism)
- [ ] Performance dashboard with latency metrics
- [ ] Automated deployment pipeline
- [ ] Integration in other strategies (CrossChain, IntraChain)

---

## Monitoring & Observability

### Metrics to Track

```typescript
interface BatchQuoterMetrics {
  totalQuotes: number;           // Total quote requests
  successfulQuotes: number;       // Successful batched quotes
  fallbackUsed: number;           // Times fallback triggered
  averageLatencyMs: number;       // Average request latency
  lastUpdated: number;            // Timestamp
}
```

### Logging

```typescript
// Success
logger.info('Batched quote successful', {
  chain,
  opportunityId,
  latencyMs: 45,
  profit: '0.1 ETH'
});

// Fallback
logger.warn('Batched quote failed, using fallback', {
  chain,
  opportunityId,
  reason: 'RPC timeout',
  fallbackLatencyMs: 180
});
```

### Alerts

- ❌ Fallback rate > 20% (investigate quoter availability)
- ❌ Average latency > 100ms (not achieving target)
- ✅ Average latency < 50ms (success!)

---

## References

- [FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md](../../research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md) - Original research and planning
- [FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md](../../research/FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md) - Performance analysis
- [ADR-016: Transaction Simulation](ADR-016-transaction-simulation.md) - Related simulation patterns
- [ADR-020: Flash Loan Integration](ADR-020-flash-loan.md) - Flash loan strategy architecture
- [MultiPathQuoter.sol](../../contracts/src/MultiPathQuoter.sol) - Contract implementation
- [batch-quoter.service.ts](../../services/execution-engine/src/services/simulation/batch-quoter.service.ts) - Service implementation

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-06 | 1.0 | Initial version - Task 1.2 implementation |
