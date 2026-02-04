# ADR-023: Detector Pre-validation

## Status
Accepted

## Date
2025-02-04

## Context

The arbitrage system detects opportunities across 11 blockchains and publishes them to the execution engine. However, many detected opportunities fail during execution due to:
- Insufficient liquidity at expected prices
- Reverted transactions due to slippage
- Stale price data leading to unprofitable trades
- DEX router limitations

Without pre-validation, the execution engine wastes resources attempting to execute opportunities that will fail, consuming:
- Gas fees for failed transactions
- Rate limits on simulation providers
- Compute resources for failed executions
- Latency on subsequent valid opportunities

## Decision

Implement **sample-based pre-validation** at the detector level to filter out opportunities that would fail execution before publishing them to the execution stream.

### Key Design Decisions

1. **Sample-based validation**: Only validate a configurable percentage of opportunities (default 10%) to stay within rate limits and avoid adding latency to the hot path.

2. **Budget-limited**: Monthly simulation budget prevents runaway costs. Pre-validation uses 10% of the overall simulation budget, leaving 90% for execution.

3. **Provider preference**: Use Alchemy (practically unlimited free tier) for pre-validation to preserve Tenderly budget for execution-time simulation.

4. **Profit threshold**: Only pre-validate opportunities above a minimum profit threshold (default $50 USD) to avoid wasting validation on low-value opportunities.

5. **Fail-open design**: On validation errors, allow the opportunity through rather than blocking potentially valid opportunities.

6. **Latency-bounded**: Skip pre-validation if it would exceed max latency (default 100ms) to maintain detection speed.

### Configuration

```typescript
interface PreValidationConfig {
  enabled: boolean;           // Default: false (until integration complete)
  sampleRate: number;         // Default: 0.1 (10%)
  minProfitForValidation: number; // Default: 50 USD
  maxLatencyMs: number;       // Default: 100ms
  monthlyBudget: number;      // Default: 2500 simulations
  preferredProvider: 'tenderly' | 'alchemy' | 'local'; // Default: 'alchemy'
}
```

### Budget Allocation

| Provider | Monthly Free Tier | Pre-validation | Execution |
|----------|-------------------|----------------|-----------|
| Tenderly | 25,000 | 0 (preserve) | 25,000 |
| Alchemy | ~Unlimited | 2,500+ | As needed |
| Helius (Solana) | 100,000 | 10,000 | 90,000 |

### Implementation Location

Pre-validation is implemented in `CrossChainDetectorService.publishArbitrageOpportunity()`:

```typescript
// services/cross-chain-detector/src/detector.ts
private async publishArbitrageOpportunity(opportunity: CrossChainOpportunity): Promise<void> {
  if (preValidConfig?.enabled) {
    const shouldPreValidate = await this.shouldPreValidate(opportunity, preValidConfig);
    if (shouldPreValidate) {
      const isValid = await this.preValidateOpportunity(opportunity, preValidConfig);
      if (!isValid) {
        return; // Skip publishing
      }
    }
  }
  await this.opportunityPublisher.publish(opportunity);
}
```

## Consequences

### Positive

- **Reduced wasted execution**: Filtering invalid opportunities saves gas fees and rate limits
- **Higher opportunity quality**: Execution engine receives higher-quality opportunities
- **Observable metrics**: Pre-validation success rate provides insight into opportunity quality
- **Budget control**: Monthly limits prevent runaway simulation costs
- **Configurable**: Operators can tune sample rate and thresholds per environment

### Negative

- **Added complexity**: Pre-validation adds code paths and configuration options
- **Potential false negatives**: Sample-based approach may filter some valid opportunities
- **Rate limit consumption**: Uses simulation API quota that could be used elsewhere
- **Latency**: Adds up to 100ms latency for validated opportunities

### Neutral

- **SimulationService dependency**: Full integration requires SimulationService availability at detector level (currently placeholder implementation)

## Alternatives Considered

### 1. Full validation (100% of opportunities)
**Rejected**: Would exceed rate limits and add too much latency to the hot path.

### 2. Post-detection validation in execution engine
**Current approach**: This already exists but happens too late - after opportunities are published. Pre-validation filters earlier in the pipeline.

### 3. ML-based opportunity quality scoring
**Complementary**: Could be combined with pre-validation for improved filtering.

## Related

- ADR-016: Transaction Simulation - Describes the simulation infrastructure used for pre-validation
- ADR-014: Modular Detector Components - Detector architecture where pre-validation is implemented
- `services/cross-chain-detector/src/types.ts` - PreValidationConfig type definition
- `services/cross-chain-detector/src/detector.ts` - Implementation location

## Future Work

1. **SimulationService integration**: Complete the integration with SimulationService for actual transaction simulation
2. **PendingStateSimulator integration**: Use pending state simulation for mempool-based opportunity validation
3. **ML-assisted validation**: Train a model on historical opportunity success/failure data
4. **Cross-detector rollout**: Apply pre-validation to unified detector and Solana detector
