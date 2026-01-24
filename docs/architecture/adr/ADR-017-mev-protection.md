# ADR-017: MEV Protection Enhancement

## Status
**Accepted**

## Date
2026-01-23

## Context

The original MEV protection was limited to Flashbots for Ethereum mainnet only. This created several gaps:

1. **Solana exposure**: No MEV protection for Solana trades (significant volume)
2. **L2 vulnerability**: L2 chains had no specific MEV handling
3. **Risk assessment**: No way to evaluate MEV risk before execution
4. **One-size-fits-all**: Same approach for all transaction sizes/types

With expansion to 11 chains (including Solana), comprehensive MEV protection became critical.

## Decision

Implement chain-aware MEV protection with three major components:

### 1. Chain-Specific MEV Providers

| Chain Type | Strategy | Provider Class |
|------------|----------|----------------|
| Ethereum Mainnet | Flashbots bundles | FlashbotsProvider |
| Solana | Jito bundles | JitoProvider |
| L2 Rollups (Arbitrum, Optimism, Base) | Sequencer protection | L2SequencerProvider |
| BSC, Polygon | Private pools / standard | StandardProvider |

### 2. MEV Risk Analyzer

Evaluates transaction MEV risk and recommends protection strategy:

```typescript
interface MevRiskAnalysis {
  sandwichRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  recommendedTip: bigint;
  mempoolRecommendation: 'public' | 'private' | 'bundle';
  riskFactors: string[];
}
```

### 3. Updated MEV Provider Factory

```typescript
// Chain-aware provider selection
const provider = await mevProviderFactory.createProviderAsync(chain, config);

// Factory throws clear error for Solana (requires different SDK)
// Use createJitoProvider() directly for Solana
```

## Rationale

### Why Jito for Solana?

1. **Market leader**: Jito processes majority of Solana MEV bundles
2. **Bundle guarantees**: Atomic execution or full revert
3. **Tip optimization**: Built-in tip calculation for bundle priority
4. **Recovery fallback**: Can fall back to public mempool if bundle fails

### Why L2 Sequencer Strategy?

L2 rollups have centralized sequencers that:
1. Process transactions in order received
2. Have much lower MEV risk than L1
3. Don't benefit from Flashbots-style bundles
4. Priority fee is sufficient for ordering

### Why Risk Analyzer?

Different transactions have different MEV exposure:
1. **Large swaps**: High sandwich risk, need private mempool
2. **Small trades**: Low risk, public mempool OK
3. **Multi-hop**: Complex path increases risk
4. **High-value tokens**: More attractive to attackers

## Consequences

### Positive

- **Solana protection**: Jito bundles protect high-value Solana trades
- **Risk-adjusted protection**: Don't overpay for protection on low-risk trades
- **Chain-specific optimization**: Each chain gets appropriate strategy
- **Cost savings**: Skip expensive protection when unnecessary

### Negative

- **Complexity**: Multiple providers to maintain
- **Jito dependency**: Solana protection relies on Jito infrastructure
- **Tip costs**: Bundle tips reduce profit margins

### Neutral

- **Async initialization**: Thread-safe provider creation adds complexity
- **Testing**: Need chain-specific mocks

## Alternatives Considered

### 1. Flashbots for Everything
**Rejected** because:
- Flashbots is Ethereum-only
- Doesn't work on Solana (different architecture)
- Overkill for L2s with sequencer protection

### 2. Skip MEV Protection
**Rejected** because:
- Sandwich attacks can eliminate profit
- Competitive disadvantage vs protected bots
- Solana MEV is particularly aggressive

### 3. Build Own Bundle System
**Rejected** because:
- Enormous complexity
- Would need searcher relationships
- Existing solutions (Flashbots, Jito) are mature

## Implementation Details

### Files Created/Modified
- `shared/core/src/mev-protection/jito-provider.ts` (NEW)
- `shared/core/src/mev-protection/mev-risk-analyzer.ts` (NEW)
- `shared/core/src/mev-protection/factory.ts` (ENHANCED)
- `shared/core/src/mev-protection/l2-sequencer-provider.ts` (NEW)

### Jito Integration

```typescript
const jitoProvider = createJitoProvider({
  chain: 'solana',
  connection: solanaConnection,
  keypair: walletKeypair,
  enabled: true,
  tipLamports: 10000, // ~0.00001 SOL tip
  fallbackToPublic: true,
});

// Submit bundle
const result = await jitoProvider.submitBundle([transaction]);
```

### Risk Analyzer Usage

```typescript
const analyzer = new MevRiskAnalyzer();
const analysis = analyzer.analyzeTransaction({
  chain: 'ethereum',
  value: parseEther('10'),
  tokenPath: ['WETH', 'USDC', 'WETH'],
  expectedProfit: parseEther('0.1'),
});

if (analysis.mempoolRecommendation === 'private') {
  // Use Flashbots
}
```

## Success Criteria

- ✅ Jito bundles working for Solana
- ✅ MEV risk scoring provides recommendations
- ⏳ MEV protection coverage > 95% (needs production validation)
- ⏳ Sandwich attack losses reduced by 50%+ (needs production validation)

## References

- [Jito Documentation](https://jito-labs.gitbook.io/mev/)
- [Flashbots Documentation](https://docs.flashbots.net/)
- [Implementation Plan v2.0](../../reports/implementation_plan_v2.md) Task 1.2

## Confidence Level
90% - High confidence based on:
- Jito is battle-tested in production
- Risk analyzer follows established MEV research
- Clear chain-specific strategies
- Comprehensive test suite (69 tests for JitoProvider)
