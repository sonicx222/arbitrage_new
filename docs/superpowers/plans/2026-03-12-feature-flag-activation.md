# Feature Flag Activation — 2026-03-12

Enabled all feature flags that can be safely activated without external dependencies or contract deployments. Changes applied consistently across `.env`, `.env.local`, and `.env.example`.

## Newly Enabled (5 flags)

| Flag | Purpose | Why Safe |
|------|---------|----------|
| `FEATURE_FAST_LANE` | Bypasses coordinator queue for high-confidence, high-profit opportunities via `stream:fast-lane` Redis stream | Pure software + Redis; EE deduplicates against normal path |
| `FEATURE_ADAPTIVE_RISK_SCORING` | Tracks sandwich attacks in Redis, dynamically tightens MEV risk thresholds per chain+DEX | Only needs Redis (always available); 7-day retention with FIFO pruning |
| `FEATURE_CEX_PRICE_SIGNALS` | Binance public WS trade stream provides CEX-DEX spread analysis for opportunity scoring | No API key needed; in `SIMULATION_MODE` uses synthetic prices from DEX data |
| `FEATURE_BACKRUN_STRATEGY` | Registers `BackrunStrategy` in execution engine strategy factory | No-op without MEV-Share backrun events arriving; just strategy registration |
| `FEATURE_UNISWAPX_FILLER` | Registers `UniswapXFillerStrategy` in execution engine strategy factory | No-op without UniswapX Dutch auction orders arriving; just strategy registration |

## Aligned Across Files (6 flags)

These were already `true` in `.env` but `false` or commented out in `.env.local` and/or `.env.example`. Now consistent everywhere.

| Flag | Purpose |
|------|---------|
| `FEATURE_MOMENTUM_TRACKING` | PriceMomentumTracker records price updates from Sync events |
| `FEATURE_ML_SIGNAL_SCORING` | Background ML confidence score pre-computation (500ms interval) |
| `FEATURE_SIGNAL_CACHE_READ` | Hot-path filtering of low-confidence opportunities via cached ML scores |
| `FEATURE_LIQUIDITY_DEPTH_SIZING` | LiquidityDepthAnalyzer computes slippage-knee optimal trade sizes |
| `FEATURE_STATISTICAL_ARB` | Statistical arbitrage detection and execution |
| `FEATURE_COW_BACKRUN` | CoW Protocol settlement backrun detection |

## Previously Enabled (5 flags, unchanged)

| Flag | Status |
|------|--------|
| `FEATURE_MEV_SHARE` | Already `true` — MEV-Share rebate capture via Flashbots |
| `FEATURE_FLASH_LOAN_AGGREGATOR` | Already `true` — dynamic flash loan provider selection |
| `FEATURE_DYNAMIC_L1_FEES` | Already `true` (opt-out pattern `!== 'false'`) — L1 fee oracle queries |

## Still Disabled (8 flags — require external dependencies)

| Flag | Dependency Required |
|------|-------------------|
| `FEATURE_BATCHED_QUOTER` | MultiPathQuoter contract deployment per chain |
| `FEATURE_COMMIT_REVEAL` | CommitRevealArbitrage contract deployment per chain |
| `FEATURE_COMMIT_REVEAL_REDIS` | Depends on `FEATURE_COMMIT_REVEAL` being enabled |
| `FEATURE_DEST_CHAIN_FLASH_LOAN` | FlashLoanArbitrage contract deployed on destination chains |
| `FEATURE_SOLANA_EXECUTION` | `SOLANA_RPC_URL` + Solana wallet configuration |
| `FEATURE_ORDERFLOW_PIPELINE` | mempool-detector service + `BLOXROUTE_AUTH_HEADER` |
| `FEATURE_KMS_SIGNING` | AWS KMS setup + `@aws-sdk/client-kms` |
| `FEATURE_MEV_SHARE_BACKRUN` | External Flashbots MEV-Share SSE endpoint |

Not in env files (commented references only):
- `FEATURE_FLASHBOTS_PROTECT_L2` — Flashbots Protect L2 RPC endpoints
- `FEATURE_TIMEBOOST` — Arbitrum Timeboost auction infrastructure

## Result

**16 of 21 flags now enabled** (was 9/21). All 3 env files are consistent.

## Files Modified

- `.env` — 5 flags enabled, 2 sections added (CEX, Fast Lane)
- `.env.local` — 11 flags enabled/aligned (gitignored)
- `.env.example` — 11 flags enabled/aligned (committed template)
