# Future Enhancements

This document tracks deferred enhancements that are intentionally not implemented yet. Each enhancement includes rationale for deferral and review triggers for reconsideration.

## Table of Contents

- [FE-001: Flash Loans on Destination Chain (Cross-Chain Strategy)](#fe-001-flash-loans-on-destination-chain-cross-chain-strategy)

---

## FE-001: Flash Loans on Destination Chain (Cross-Chain Strategy)

**Status**: DEFERRED
**Priority**: Medium
**Estimated Effort**: 3 days
**Dependencies**: FlashLoanProviderFactory
**Module**: `services/execution-engine/src/strategies/cross-chain.strategy.ts:684-722`
**Created**: 2026-02-08 (I5 fix - code review follow-up)

### Current Implementation

Direct DEX swap after bridge completion.

**Pros**:
- Simple implementation
- Works immediately after bridge
- No flash loan fees

**Cons**:
- Requires capital on destination chain
- Cannot scale to larger positions without dest chain liquidity
- Capital lockup during bridge waiting period
- Exposed to price movement during bridge delay

### Proposed Enhancement

Use flash loan on destination chain for the sell transaction after bridging.

### Benefits

1. **Larger Positions**: Can execute larger trades without holding capital on dest chain
2. **Atomic Execution**: Revert if unprofitable after bridge (reduces loss scenarios)
3. **Reduced Capital Lockup**: No need to pre-fund dest chain for trade execution
4. **Price Protection**: Flash loan execution is atomic on dest chain, reducing slippage risk

### Trade-offs

- **Flash Loan Fees**: ~0.09% on Aave V3, ~0.25-0.30% on other protocols
- **Contract Deployment**: Requires FlashLoanArbitrage contract deployed on each dest chain
- **Error Handling Complexity**: Bridge succeeded but flash loan failed scenarios
- **Not Truly Atomic**: Cross-chain flash loans are NOT atomic (bridge completes before flash loan)

### Decision Rationale

**Deferred until production metrics show capital constraints on dest chains.**

- Direct swaps are simpler and sufficient for current trade sizes
- Current approach handles bridge completion + DEX swap without flash loan overhead
- Adding flash loans increases complexity without demonstrated need

### Implementation Plan (When Reconsidered)

```typescript
// 1. Check if flash loans supported on dest chain
if (FlashLoanProviderFactory.isFullySupported(destChain)) {
  // 2. Use FlashLoanStrategy for sell transaction
  const result = await this.flashLoanStrategy.executeArbitrage(sellOpportunity);
} else {
  // 3. Fall back to direct swap (current behavior)
  const result = await this.dexSwapper.swap(sellOpportunity);
}

// 4. Add metrics to compare profitability
this.metrics.recordFlashLoanDestChainProfit(profit);
this.metrics.recordDirectSwapProfit(profit);
```

### Review Triggers

Reconsider this enhancement if **ANY** of the following occur:

1. **Capital Constraints**: Average dest chain capital < $10K **AND** affecting trade sizes (rejected profitable opportunities)
2. **Capital Lockup Impact**: Capital lockup during bridge wait becomes significant (>5 minutes average bridge time)
3. **Fee Reduction**: Flash loan fees drop below 0.05% (making flash loan overhead negligible)
4. **Trade Size Increase**: Average cross-chain trade size >$50K (current capital insufficient)

### Metrics to Monitor

Add these metrics to track when review is needed:

```typescript
// In cross-chain.strategy.ts
this.metrics.recordDestChainCapitalUsage(chain, amountUsed);
this.metrics.recordBridgeWaitTime(bridgeName, waitTimeMs);
this.metrics.recordRejectedOpportunityDueToCapital(opportunity);
```

### Related Issues

- **Tracking Issue**: docs/FUTURE_ENHANCEMENTS.md#FE-001 (this document)
- **Related ADRs**: ADR-011 (Flash Loan Aggregation), ADR-014 (Cross-Chain Strategy)

### Last Reviewed

- 2026-02-08: Initial documentation (I5 fix)

---

## Adding New Enhancements

When adding a new deferred enhancement:

1. **Use Sequential IDs**: FE-XXX (starting from FE-002)
2. **Include Required Sections**:
   - Status, Priority, Effort, Dependencies
   - Current Implementation (what exists now)
   - Proposed Enhancement (what you're deferring)
   - Benefits and Trade-offs
   - Decision Rationale (WHY deferred)
   - Review Triggers (WHEN to reconsider)
   - Metrics to Monitor

3. **Update Code Reference**:
   ```typescript
   // FUTURE ENHANCEMENT (FE-XXX): [Title]
   // Tracking: docs/FUTURE_ENHANCEMENTS.md#FE-XXX
   ```

4. **Link to Related Docs**: ADRs, implementation plans, etc.

---

## Status Definitions

- **DEFERRED**: Enhancement planned but intentionally not implemented yet
- **UNDER REVIEW**: Review triggers met, evaluating for implementation
- **APPROVED**: Approved for implementation, create tracking issue
- **IMPLEMENTED**: Enhancement completed, documented for reference
- **REJECTED**: Enhancement reviewed and permanently rejected

---

## Review Process

1. **Quarterly Review**: Engineering team reviews all DEFERRED enhancements
2. **Metric-Driven**: Automated alerts when review triggers are met
3. **Priority Adjustment**: Priorities can be adjusted based on business needs
4. **Documentation Update**: Update this document when status changes

---

**NOTE**: This is NOT a backlog or task tracker. Use GitHub Issues for actual implementation tracking. This document explains WHY things are deferred and WHEN to reconsider them.
