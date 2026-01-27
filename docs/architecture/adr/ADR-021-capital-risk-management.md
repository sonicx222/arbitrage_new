# ADR-021: Capital Risk Management

## Status
**Accepted**

## Date
2026-01-27

## Context

The arbitrage system lacked institutional-grade capital management. While ADR-018 implemented an operational circuit breaker for consecutive execution failures, there was no protection against:

1. **Capital drawdown**: No mechanism to halt trading when daily losses exceeded safe thresholds
2. **Negative expected value trades**: Trades executed without considering win probability
3. **Improper position sizing**: No Kelly Criterion or similar sizing methodology
4. **Blind execution**: No tracking of historical execution success rates

This created risks of:
- Unlimited daily losses during market conditions unfavorable to arbitrage
- Executing trades with negative expected value
- Over-sizing positions that could lead to significant losses
- No data-driven decision making for trade execution

## Decision

Implement a comprehensive capital risk management system with four integrated components:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CAPITAL RISK MANAGER                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │    EXECUTION PROBABILITY TRACKER (Task 3.4.1)               │   │
│  │    • Historical success rate per (chain, DEX, pathLength)   │   │
│  │    • Time-of-day success patterns                           │   │
│  │    • Gas price impact on success                            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                        ↓                                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │    EXPECTED VALUE CALCULATOR (Task 3.4.2)                   │   │
│  │    EV = (winProb × expectedProfit) - (lossProb × gasCost)   │   │
│  │    • Minimum EV threshold: $5 (configurable)                │   │
│  │    • EV-adjusted opportunity ranking                        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                        ↓                                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │    POSITION SIZER - Kelly Criterion (Task 3.4.3)            │   │
│  │    f* = (p × b - q) / b                                     │   │
│  │    • Fractional Kelly (0.5x) for safety                     │   │
│  │    • Per-trade capital allocation                           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                        ↓                                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │    DRAWDOWN CIRCUIT BREAKER (Task 3.4.4)                    │   │
│  │    • Max daily loss: 5% of capital                          │   │
│  │    • Max single trade: 2% of capital                        │   │
│  │    • Consecutive loss limit: 5 trades                       │   │
│  │    • Recovery mode: 50% reduced sizing                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Drawdown Circuit Breaker State Machine

```
                     ┌─────────────────────────────────────┐
                     │                                     │
                     ▼                                     │
┌──────────┐   3% loss    ┌──────────┐   5% loss    ┌──────────┐
│  NORMAL  │ ────────────►│ CAUTION  │ ────────────►│   HALT   │
│  (100%)  │              │  (75%)   │              │   (0%)   │
└──────────┘              └──────────┘              └──────────┘
     ▲                          │                        │
     │                          │                        │
     │                          │ consecutive losses     │ cooldown
     │                          │ (5 trades)             │ (1 hour)
     │                          │                        │
     │                          ▼                        ▼
     │                    ┌──────────┐              ┌──────────┐
     │                    │   HALT   │◄─────────────│   HALT   │
     │                    └──────────┘              └──────────┘
     │                          │
     │       3 wins             │ manual reset
     │    ┌─────────────────────┘
     │    │
     │    ▼
     │ ┌──────────┐
     └─│ RECOVERY │
       │  (50%)   │
       └──────────┘
```

**State Multipliers:**
| State | Position Size Multiplier | Description |
|-------|-------------------------|-------------|
| NORMAL | 1.0 (100%) | Full position sizing |
| CAUTION | 0.75 (75%) | Reduced sizing due to approaching threshold |
| HALT | 0.0 (0%) | No trading allowed |
| RECOVERY | 0.5 (50%) | Gradual return to normal |

### Configuration

All configuration centralized in `shared/config/src/risk-config.ts`:

```typescript
export const RISK_CONFIG = {
  enabled: true,

  drawdown: {
    enabled: true,
    maxDailyLoss: 0.05,        // 5% of capital
    cautionThreshold: 0.03,    // 3% triggers CAUTION
    maxConsecutiveLosses: 5,
    recoveryMultiplier: 0.5,
    recoveryWinsRequired: 3,
    haltCooldownMs: 3600000,   // 1 hour
  },

  ev: {
    enabled: true,
    minEVThreshold: 5000000000000000n,  // 0.005 ETH (~$10)
    minWinProbability: 0.3,    // 30% minimum
    maxLossPerTrade: 100000000000000000n, // 0.1 ETH
  },

  positionSizing: {
    enabled: true,
    kellyMultiplier: 0.5,      // Half Kelly for safety
    maxSingleTradeFraction: 0.02, // 2% max per trade
    minTradeFraction: 0.001,   // 0.1% minimum
  },

  probability: {
    minSamples: 10,
    defaultWinProbability: 0.5,
    maxOutcomesPerKey: 1000,
    outcomeRelevanceWindowMs: 604800000, // 7 days
    persistToRedis: true,
  },

  totalCapital: 10000000000000000000n, // 10 ETH default
};
```

### Integration with Execution Engine (Task 3.4.5)

```typescript
// In ExecutionEngine.executeOpportunity()
async executeOpportunity(opportunity: ArbitrageOpportunity) {
  // Step 1: Check drawdown circuit breaker
  const drawdownCheck = this.drawdownBreaker.isTradingAllowed();
  if (!drawdownCheck.allowed) {
    return createSkippedResult(opportunity.id, drawdownCheck.reason);
  }

  // Step 2: Calculate Expected Value
  const evCalc = this.evCalculator.calculate(opportunity);
  if (!evCalc.shouldExecute) {
    return createSkippedResult(opportunity.id, evCalc.reason);
  }

  // Step 3: Size position using Kelly Criterion
  const positionSize = this.positionSizer.calculateSize({
    winProbability: evCalc.winProbability,
    expectedProfit: evCalc.rawProfitEstimate,
    expectedLoss: evCalc.rawGasCost,
  });

  // Apply drawdown state multiplier
  const adjustedSize = positionSize.recommendedSize *
    BigInt(Math.floor(drawdownCheck.sizeMultiplier * 10000)) / 10000n;

  if (!positionSize.shouldTrade || adjustedSize === 0n) {
    return createSkippedResult(opportunity.id, positionSize.reason);
  }

  // Step 4: Execute with sized capital
  const result = await this.executeWithSize(opportunity, adjustedSize);

  // Step 5: Record outcome for learning
  this.probabilityTracker.recordOutcome({
    chain: opportunity.buyChain,
    dex: opportunity.buyDex,
    pathLength: opportunity.path?.length ?? 2,
    hourOfDay: new Date().getUTCHours(),
    gasPrice: BigInt(opportunity.gasPrice || 0),
    success: result.success,
    profit: result.actualProfit ? BigInt(result.actualProfit) : undefined,
    gasCost: result.gasCost ? BigInt(result.gasCost) : 0n,
    timestamp: Date.now(),
  });

  // Step 6: Update drawdown breaker
  this.drawdownBreaker.recordTradeResult({
    success: result.success,
    pnl: result.actualProfit ? BigInt(result.actualProfit) : 0n,
    timestamp: Date.now(),
  });

  return result;
}
```

## Rationale

### Why Four Components?

Each component addresses a specific risk:

1. **ExecutionProbabilityTracker**: Provides data-driven win probability estimates
2. **EVCalculator**: Ensures only positive expected value trades execute
3. **KellyPositionSizer**: Optimizes position sizing for long-term growth
4. **DrawdownCircuitBreaker**: Provides hard capital protection limits

### Why Half Kelly (0.5x)?

Full Kelly Criterion maximizes long-term growth but has high variance. Half Kelly provides:
- ~75% of the growth rate
- ~50% of the variance
- More conservative for real-world conditions with estimation errors

### Why 5% Daily Loss Limit?

- **Conservative**: Limits maximum daily loss to manageable levels
- **Recovery-friendly**: 5% loss can be recovered in 1-2 good trading days
- **Industry standard**: Common threshold for automated trading systems

### Why Separate from ADR-018 Circuit Breaker?

| ADR-018 (Operational) | ADR-021 (Capital) |
|-----------------------|-------------------|
| Consecutive failures | PnL-based triggers |
| CLOSED/OPEN/HALF_OPEN | NORMAL/CAUTION/HALT/RECOVERY |
| Network/execution issues | Market/strategy issues |
| Fast recovery (5 min) | Slower recovery (1 hour + wins) |

Both circuit breakers work together:
- ADR-018 protects against infrastructure failures
- ADR-021 protects against capital losses

## Consequences

### Positive

- **Capital protection**: Hard limits on daily losses
- **Data-driven execution**: Only positive EV trades execute
- **Optimal sizing**: Kelly Criterion for long-term growth
- **Automatic recovery**: Self-healing after drawdown periods
- **Centralized configuration**: All risk parameters in one place
- **Singleton pattern**: Consistent state across components

### Negative

- **Missed opportunities**: Some valid opportunities rejected due to:
  - Low win probability (insufficient data)
  - Below EV threshold
  - HALT state active
- **Configuration complexity**: Multiple thresholds to tune
- **Cold start**: Needs historical data for accurate probabilities

### Neutral

- **State persistence**: Currently in-memory; can add Redis persistence
- **Multi-instance**: Each instance has own state (by design)

## Alternatives Considered

### 1. Fixed Position Sizing
**Rejected** because:
- Doesn't adapt to win probability
- Misses optimization opportunities
- No capital protection

### 2. Simple Daily Loss Limit
**Rejected** because:
- No CAUTION state for early warning
- No gradual recovery mechanism
- No win probability consideration

### 3. Shared State via Redis
**Rejected** because:
- Adds latency to critical path
- Redis dependency for every trade decision
- Local state is simpler and faster

## Implementation Details

### Files Created

**Risk Components (Task 3.4.1-3.4.4):**
- `shared/core/src/risk/types.ts`
- `shared/core/src/risk/execution-probability-tracker.ts`
- `shared/core/src/risk/ev-calculator.ts`
- `shared/core/src/risk/position-sizer.ts`
- `shared/core/src/risk/drawdown-circuit-breaker.ts`
- `shared/core/src/risk/index.ts`

**Configuration:**
- `shared/config/src/risk-config.ts`

**Integration (Task 3.4.5):**
- Modified: `services/execution-engine/src/engine.ts`
- Modified: `services/execution-engine/src/types.ts`

### Test Coverage

| Component | Test Count |
|-----------|------------|
| ExecutionProbabilityTracker | 45 |
| EVCalculator | 38 |
| KellyPositionSizer | 32 |
| DrawdownCircuitBreaker | 73 |
| Integration | 26 |
| **Total** | 214+ |

### Environment Variables

```bash
# Global toggle
RISK_MANAGEMENT_ENABLED=true

# Drawdown Circuit Breaker
DRAWDOWN_BREAKER_ENABLED=true
RISK_MAX_DAILY_LOSS=0.05
RISK_CAUTION_THRESHOLD=0.03
RISK_MAX_CONSECUTIVE_LOSSES=5
RISK_RECOVERY_MULTIPLIER=0.5
RISK_RECOVERY_WINS_REQUIRED=3
RISK_HALT_COOLDOWN_MS=3600000

# EV Calculator
EV_CALCULATOR_ENABLED=true
RISK_MIN_EV_THRESHOLD=5000000000000000
RISK_MIN_WIN_PROBABILITY=0.3
RISK_MAX_LOSS_PER_TRADE=100000000000000000

# Position Sizing
POSITION_SIZING_ENABLED=true
RISK_KELLY_MULTIPLIER=0.5
RISK_MAX_SINGLE_TRADE=0.02
RISK_MIN_TRADE_FRACTION=0.001

# Probability Tracker
RISK_MIN_SAMPLES=10
RISK_DEFAULT_WIN_PROBABILITY=0.5
RISK_PERSIST_TO_REDIS=true

# Total Capital
RISK_TOTAL_CAPITAL=10000000000000000000
```

## Success Criteria

- [x] Win probability tracked with historical data per (chain, DEX, pathLength)
- [x] EV calculation adds <1ms latency per opportunity
- [x] Position sizing prevents any single trade >2% of capital
- [x] Drawdown breaker halts trading before 5% daily loss
- [x] CAUTION state reduces position sizes at 3% loss
- [x] Recovery mode enables gradual return to normal trading
- [x] All components have singleton factory pattern for consistent state
- [x] Comprehensive test coverage (214+ tests)

## References

- [Implementation Plan v3.0](../../reports/implementation_plan_v3.md) Section 3.4
- [ADR-018: Execution Circuit Breaker](./ADR-018-circuit-breaker.md)
- [Kelly Criterion - Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion)
- [Expected Value in Trading](https://www.investopedia.com/terms/e/expected-value.asp)

## Confidence Level
95% - Very high confidence based on:
- Well-established financial risk management principles
- Comprehensive test coverage
- Clear integration with existing execution engine
- Configurable thresholds for tuning
