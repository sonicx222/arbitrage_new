# Free Tiers Comparison: Alchemy, Infura, QuickNode, dRPC, Ankr, and PublicNode

### Key Points
- Alchemy's free tier remains the most generous for compute-intensive tasks with 30 million CU per month and 25 RPS, supporting a wide array of chains including Ethereum and Solana, though it caps at 5 apps and lacks premium support.
- Infura provides 3 million credits daily (roughly equivalent to moderate usage) across 40+ networks, but daily resets prevent rollover, making it suitable for consistent low-volume testing.
- QuickNode's free tier offers 10 million API credits monthly with 15 RPS, including basic webhook and IPFS support, but excludes archive data and advanced APIs.
- dRPC's free tier delivers 210 million CU per 30 days over public nodes for 108+ chains, with dynamic throughput of 40-100 RPS, ideal for decentralized access but with potential slowdowns during high demand.
- Ankr's Freemium tier includes 200 million API credits monthly at 30 RPS for Node API across limited chains, serving as a bridge to premium features without initial cost.
- PublicNode stands out as completely free with no sign-up required, supporting 102 blockchains via public endpoints, handling high global throughput (85k+ req/sec average), though performance varies as a shared resource without guarantees.
- Research suggests these free tiers effectively support prototyping and small-scale development, but evidence leans toward paid upgrades for production due to rate limits, reliability concerns, and feature gaps—particularly in high-demand scenarios.
- While no major controversies exist around these providers, debates in developer communities highlight trade-offs between decentralization (e.g., dRPC, PublicNode) and centralized performance (e.g., Alchemy, Infura), with users noting occasional throttling on free public options.

### Metrics and Pricing Overview
All providers offer free entry-level access measured via credits or units, focusing on multi-chain support without upfront costs. PublicNode is unique as fully public and unlimited in credits, though implicitly limited by shared infrastructure.

| Provider    | Monthly/Daily Limit               | Throughput (RPS or Equivalent) | Supported Chains/Networks | Price |
|-------------|-----------------------------------|--------------------------------|---------------------------|-------|
| Alchemy    | 30M CU/month                     | 25 RPS (500 CU/s)             | Ethereum, L2s (e.g., Polygon, Arbitrum), Solana, BNB, etc. | $0   |
| Infura     | 3M credits/day                   | 500 credits/s                 | 40+ (Ethereum, Polygon, etc.) | $0   |
| QuickNode  | 10M API credits/month            | 15 RPS                        | Multi-chain (Ethereum, Solana, etc.) | $0   |
| dRPC       | 210M CU/30 days                  | 40-100 RPS (dynamic, 50,400-120,000 CU/min) | 108+ (EVM, non-EVM)      | $0   |
| Ankr       | 200M API credits/month (Freemium)| 30 RPS (Node API)             | 75+ (limited in Freemium) | $0   |
| PublicNode | Unlimited (shared public)        | Variable (~100-200 RPS per IP inferred) | 102 (Ethereum, Solana, etc.) | $0   |

### Getting Started Data
Onboarding is straightforward across providers, typically involving account creation (except PublicNode), API key generation, and simple HTTP/JSON-RPC requests. Code examples often use cURL or JavaScript for initial block number fetches.

- For dRPC and Ankr, sign up via their dashboards to access free credits; PublicNode allows direct endpoint usage without registration.
- Requirements include basic programming knowledge and tools like cURL or libraries (e.g., ethers.js).

### Limitations Summary
Free tiers prioritize accessibility over enterprise-grade reliability, with common caps on RPS, no SLAs, limited support, and exclusions for advanced methods like traces or archives. Overuse may result in throttling, pushing users toward paid plans for scalability.

---

Blockchain infrastructure providers like Alchemy, Infura, QuickNode, dRPC, Ankr, and PublicNode enable developers to access decentralized networks efficiently without self-hosting nodes. Their free tiers lower barriers for entry, supporting innovation in Web3 applications as of January 30, 2026. This expanded report incorporates dRPC, Ankr, and PublicNode alongside the originals, drawing from official sources for metrics, pricing, getting started processes, limitations, and documentation. Focus remains on Ethereum and multi-chain capabilities, with data verified across providers' sites and comparisons.

### Detailed Metrics and Pricing Breakdown
Providers use varied units (e.g., CU, credits) to meter usage, preventing abuse while offering substantial free allocations. PublicNode differs as purely public with no metering.

- **Alchemy**:
  - **Metrics**: 30 million CU/month; costs vary by method (e.g., 10 CU for blockNumber, 26 CU for eth_call); 500 CU/second throughput (~25 RPS).
  - **Pricing**: $0, no card needed.
  - **Supported Chains**: Ethereum mainnet/testnets, L2s (Polygon, Arbitrum, Optimism), Solana, BNB Smart Chain, Avalanche, etc.
  - **Additional Data**: 5 apps, 5 webhooks; ideal for small teams.

- **Infura**:
  - **Metrics**: 3 million credits/day; method-specific costs; 500 credits/second.
  - **Pricing**: $0, one API key.
  - **Supported Networks**: 40+, including Ethereum and Polygon.
  - **Additional Data**: 24-hour request visibility; community support.

- **QuickNode**:
  - **Metrics**: 10 million API credits/month; 15 RPS; includes 333k webhook payloads, 1 GB/month streams, 10 GB/month IPFS.
  - **Pricing**: $0 (entry-level inferred free).
  - **Supported Blockchains**: Multi-chain, including Ethereum and Solana.
  - **Additional Data**: Overages charged (e.g., $0.06/GB IPFS).

- **dRPC**:
  - **Metrics**: 210 million CU/30 days; dynamic limits (120,000 CU/min normal, down to 50,400 CU/min under load; ~40-100 RPS); min 10 CU per call for rate limiting.
  - **Pricing**: $0 for free tier.
  - **Supported Chains**: 108+, including EVM and non-EVM networks.
  - **Additional Data**: Load-balanced over public nodes; some methods (e.g., eth_chainId) cost 0 CU but counted as 10 for limits.

- **Ankr**:
  - **Metrics**: 200 million API credits/month (Freemium); 30 RPS Node API, 30 reqs/min Advanced API; credits per method (e.g., 200k/1k EVM requests, 500k/1k Solana).
  - **Pricing**: $0, with Public option for no-signup access (lower limits).
  - **Supported Chains**: 75+ in Freemium (limited vs. premium); EVM, Solana, Beacon chains.
  - **Additional Data**: ~1,800 reqs/min guaranteed, more possible; gRPC at 10k credits/1k calls.

- **PublicNode**:
  - **Metrics**: Unlimited credits (shared); global stats show 85k+ avg req/sec, 37% cached; inferred 100-200 RPS per IP.
  - **Pricing**: $0, no tiers.
  - **Supported Chains**: 102, including Ethereum, Solana, Polygon, Arbitrum, Avalanche.
  - **Additional Data**: Privacy-first; handles billions of requests daily.

| Feature Comparison | Alchemy (Free) | Infura (Free) | QuickNode (Free) | dRPC (Free) | Ankr (Freemium) | PublicNode (Free) |
|--------------------|----------------|---------------|------------------|-------------|-----------------|-------------------|
| Usage Metric      | 30M CU/month  | 3M credits/day | 10M API credits/month | 210M CU/30 days | 200M API credits/month | Unlimited (shared) |
| Throughput        | 25 RPS        | 500 credits/s | 15 RPS          | 40-100 RPS (dynamic) | 30 RPS (Node API) | Variable (~100-200 RPS) |
| Apps/Endpoints    | 5 apps, 5 webhooks | 1 API key   | 1 endpoint      | Up to 5 API keys | 1 project      | Unlimited (public) |
| Data Retention    | Standard      | 24-hour visibility | 1-hour logs    | Standard        | Standard       | Not specified     |
| Advanced Features | Limited       | Expansion APIs | Streams (1 GB/mo), IPFS (10 GB/mo) | No trace/debug/filter | Advanced API (limited) | Basic RPC only   |

### Getting Started Processes
Providers emphasize quick setup, often email-based signup (except PublicNode) and dashboard-based key creation. Initial requests use JSON-RPC standards.

- **Alchemy**: Create account, generate API key in dashboard, select network; endpoint: `https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY`. Use cURL or JS for first call. Requirements: Web dev basics. (https://docs.alchemy.com/docs/alchemy-quickstart-guide)

- **Infura**: Signup, create project for API key; endpoint: `https://mainnet.infura.io/v3/YOUR_PROJECT_ID`. POST requests via JSON-RPC. Requirements: JSON-RPC familiarity. (https://docs.infura.io/)

- **QuickNode**: Free trial signup; endpoint: `https://{endpoint-name}.quiknode.pro/{token}/`. Examples: cURL for eth_blockNumber, JS with ethers.js. Requirements: Dev environment. (https://www.quicknode.com/docs)

- **dRPC**: Register, create up to 5 API keys; endpoints via dashboard. First request: Standard JSON-RPC (e.g., eth_blockNumber). No specific code in browsed docs, but similar to others. Requirements: Basic API knowledge. (https://drpc.org/docs)

- **Ankr**: Start as Public user (no signup) or Freemium (signup for credits); generate personal API tokens. Endpoints: `https://rpc.ankr.com/ethereum`. Use cURL/JS for requests. Requirements: Interface navigation. (https://www.ankr.com/docs/rpc-service/getting-started/intro)

- **PublicNode**: No signup; directly use endpoints like `https://ethereum-rpc.publicnode.com`. Fetch block number via cURL. Requirements: None beyond API calls. (https://publicnode.com/)

### Limitations of Free Tiers
Designed for testing, free options restrict scale and features to promote upgrades:

- **Alchemy**: 30M CU cap; 25 RPS; email support (48-hour response); no dedicated clusters.
- **Infura**: Daily reset, no rollover; rate limiting on exceed; community support; one key; no archives.
- **QuickNode**: No archives/traces; 1-hour logs; single endpoint; overages charged; no SLA.
- **dRPC**: Public nodes (slower/unreliable); dynamic throttling (40 RPS min); no trace/debug/filter; 5 keys max.
- **Ankr**: Freemium: 30 RPS Node, limited chains/regions; community support; no whitelists or dedicated infra.
- **PublicNode**: Shared, variable performance; no SLA/support; potential IP-based limits; basic RPC only.

These constraints suit early projects but necessitate paid plans for high-traffic or advanced needs.

### Additional Documentation
- **Alchemy**: Compute Units (https://docs.alchemy.com/reference/compute-units); Pricing FAQ (https://docs.alchemy.com/reference/pay-as-you-go-pricing-faq); API Reference (https://docs.alchemy.com/).
- **Infura**: Credits (https://docs.infura.io/api/learn/pricing); Cost Table (https://docs.infura.io/api/learn/pricing/credit-cost); Monitoring (https://support.infura.io/account/billing-pricing/monitor-manage-credit-usage).
- **QuickNode**: Console API (https://www.quicknode.com/docs/console-api/getting-started); Streams (https://www.quicknode.com/docs/streams/filters); Security (https://www.quicknode.com/security).
- **dRPC**: Compute Units (https://drpc.org/docs/pricing/compute-units); Rate Limiting (https://drpc.org/docs/howitworks/ratelimiting); Privacy (https://drpc.org/privacy-policy).
- **Ankr**: Service Plans (https://www.ankr.com/docs/rpc-service/service-plans); Pricing per Request (https://www.ankr.com/docs/rpc-service/pricing); Contact Sales (https://meetings-eu1.hubspot.com/arsalan-evini).
- **PublicNode**: Endpoint List (https://publicnode.com/); No formal docs, but chain-specific pages available.

This overview underscores the balance between free accessibility and scalable needs, with dRPC emphasizing decentralization, Ankr bridging to premium, and PublicNode prioritizing simplicity.

### Key Citations
- [Alchemy Pricing](https://www.alchemy.com/pricing)
- [Infura Pricing](https://infura.io/pricing)
- [QuickNode Pricing](https://www.quicknode.com/pricing)
- [Alchemy Quickstart Guide](https://docs.alchemy.com/docs/alchemy-quickstart-guide)
- [Infura Documentation](https://docs.infura.io/)
- [QuickNode Documentation](https://www.quicknode.com/docs)
- [dRPC How Free Tier Works](https://drpc.org/blog/how-drpcs-free-tier-works)
- [dRPC Rate Limiting](https://drpc.org/docs/howitworks/ratelimiting)
- [dRPC Free vs Paid](https://drpc.org/docs/pricing/requests)
- [dRPC Changes to Free Plan](https://drpc.org/blog/upcoming-changes-to-drpcs-free-plan-effective-june-1-2025)
- [Ankr Service Plans](https://www.ankr.com/docs/rpc-service/service-plans)
- [Ankr RPC Pricing](https://www.ankr.com/rpc/pricing)
- [Ankr Getting Started](https://www.ankr.com/docs/rpc-service/getting-started/intro)
- [PublicNode Main Page](https://publicnode.com/)
- [PublicNode Ethereum RPC](https://ethereum-rpc.publicnode.com/)