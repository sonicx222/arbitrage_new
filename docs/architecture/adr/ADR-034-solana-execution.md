# ADR-034: Solana Execution via Jupiter + Jito

## Status
**Accepted**

## Date
2026-02-24

## Confidence
**85%**

## Context

Solana partition (P4) has been detect-only since launch. The detection infrastructure covers 7 DEXs with cross-chain price comparison, and the Jito MEV provider supports bundle submission, simulation, and tip account selection. The missing piece was an execution engine that could translate detected opportunities into executed trades on Solana.

Key architectural decision: Solana uses programs (not smart contracts), versioned transactions (not legacy), and a fundamentally different MEV landscape (Jito bundles, not Flashbots).

## Decision

### Jupiter V6 Aggregator API for swap routing

Use Jupiter's API (`https://quote-api.jup.ag/v6`) rather than building native program instruction encoders for each DEX.

**Rationale:** Jupiter routes across all 7 Solana DEXs automatically, returns pre-built versioned transactions, and handles the complexity of Solana's instruction model. Building native encoders for Raydium AMM, Raydium CLMM, Orca Whirlpools, Meteora DLMM, Phoenix, and Lifinity would require per-DEX instruction encoding — significantly higher maintenance burden for equivalent routing quality.

**Trade-off:** External dependency on Jupiter API availability. Mitigated by configurable timeout and fallback-to-skip behavior.

### Jito Block Engine for MEV protection

All Solana trades submitted as Jito bundles to prevent sandwich attacks, consistent with the Ethereum Flashbots approach.

**Trade-off:** Jito tip costs (default 0.001 SOL) reduce profit margin on small trades.

### SolanaExecutionStrategy (direct interface implementation)

Implements `ExecutionStrategy` directly rather than extending `BaseExecutionStrategy` (which is EVM-specific). Solana has no gas estimation (compute units instead), no nonce management (recent blockhash), and different transaction signing.

### Feature flag controlled

Activation behind `FEATURE_SOLANA_EXECUTION=true` with dynamic imports to avoid loading `@solana/web3.js` when disabled.

## Consequences

### Positive

- Solana detection-only limitation is lifted; P4 partition can now generate revenue
- Jupiter handles multi-DEX routing complexity, reducing maintenance burden
- Jito bundle submission provides MEV protection consistent with EVM approach
- Feature flag ensures zero impact on existing EVM execution paths

### Negative

- Jupiter API becomes a critical path dependency for Solana execution
- `@solana/web3.js` added to execution-engine dependencies (only loaded when feature enabled)
- Jito tip costs reduce profitability on small Solana trades

### Neutral

- Strategy factory gains `'solana'` type in resolution priority (checked before cross-chain)
- SUPPORTED_EXECUTION_CHAINS now includes `'solana'` (11 total chain types)

## Alternatives Considered

### Alternative 1: Native DEX Program Instruction Encoding

**Pros**: No external API dependency, lowest latency
**Cons**: Per-DEX instruction encoding for 7 DEXs, high maintenance burden, duplicates Jupiter's routing logic
**Rejected**: Jupiter provides equivalent routing quality with significantly lower engineering effort

### Alternative 2: Extend BaseExecutionStrategy

**Pros**: Code reuse with EVM execution path
**Cons**: BaseExecutionStrategy assumes ethers.js, gas estimation, nonce management — all EVM-specific
**Rejected**: Adapting EVM abstractions to Solana would create leaky abstractions and complexity

### Alternative 3: Separate Solana Execution Service

**Pros**: Complete isolation, independent scaling
**Cons**: Additional service to deploy/monitor, cross-service communication overhead for opportunity forwarding
**Rejected**: SolanaExecutionStrategy within the existing execution engine is simpler and sufficient for current scale

## References

- `services/execution-engine/src/strategies/solana-execution.strategy.ts`
- `services/execution-engine/src/solana/jupiter-client.ts`
- `services/execution-engine/src/solana/transaction-builder.ts`
- `shared/core/src/mev-protection/jito-provider.ts`
- [Jupiter V6 API Documentation](https://station.jup.ag/docs/apis/swap-api)
- [Jito Block Engine Documentation](https://jito-labs.gitbook.io/mev/)
- [ADR-017: MEV Protection Enhancement](./ADR-017-mev-protection.md) — Foundational MEV decision
- [ADR-003: Partitioned Chain Detectors](./ADR-003-partitioned-detectors.md) — P4 Solana partition
