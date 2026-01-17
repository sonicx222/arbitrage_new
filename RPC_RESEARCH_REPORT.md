# RPC Provider Research Report

This report consolidates deep dive research for all planned project blockchains, focusing on free RPC Endpoints and free tiers of paid API-Providers.

## Executive Summary

Most major providers (Alchemy, Infura, QuickNode, Ankr) support the majority of the planned blockchains. The most effective strategy for a "break/rate-limit free" experience is **Redundant Clustering/Rotation**. By aggregating multiple free tier keys from different providers and rotating them upon hitting rate limits (HTTP 429), the system can achieve significantly higher effective throughput and uptime than any single free tier can provide.

## Provider Overview & Limits

### 1. Alchemy
**Supported Chains:** Ethereum, Arbitrum, Optimism, Polygon, Base, Avalanche, Fantom, zkSync Era, Linea.
*   **Free Tier Limits:**
    *   **Monthly Compute Units (CUs):** 30,000,000 CUs / month.
    *   **Throughput:** 500 Compute Units Per Second (CUPS) (shared across apps). 25 requests/sec for some L2s.
    *   **Apps:** Up to 5 apps per account.
*   **Rate Limits:** Soft limits usually result in 429 errors.
*   **Timeout/Suspension:** Hitting monthly limits usually requires an upgrade or service pauses until the next billing cycle. 429s are transient.

### 2. Infura
**Supported Chains:** Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Linea, zkSync Era (via DIN).
*   **Free Tier Limits:**
    *   **Daily Requests/Credits:** 3,000,000 Credits / day (approx 100k requests depending on complexity).
    *   **Throughput:** ~500 Credits/second.
*   **Rate Limits:** Strict daily caps.
*   **Timeout/Suspension:** Service stops after daily limit is reached until reset (00:00 UTC usually).

### 3. QuickNode
**Supported Chains:** Ethereum, Arbitrum, BSC, Base, Polygon, Optimism, Avalanche, Fantom, zkSync Era, Linea.
*   **Free Tier Limits:**
    *   **Monthly Credits:** 10,000,000 API Credits / month.
    *   **Throughput:** 15-25 Requests Per Second (RPS) depending on chain.
*   **Rate Limits:** Hard limits on RPS and monthly credits.
*   **Timeout/Suspension:** Service stops or throttles heavily upon reaching monthly limits.

### 4. Ankr
**Supported Chains:** Ethereum, Arbitrum, BSC, Base, Polygon, Optimism, Avalanche, Fantom, zkSync Era, Linea.
*   **Free Tier ("Public"):** Rate limited (often ~1800 req/min or less depending on global load). No auth required.
*   **Freemium (Auth):** 200,000,000 API Credits / month.
    *   **Throughput:** ~30 RPS.
*   **Timeout/Suspension:** Public endpoints are best-effort. Freemium accounts pause/throttle after credit exhaustion.

### 5. Official/Public Endpoints (Chain-Specific)
*   **Ethereum (LlamaRPC, etc.):** Highly variable, often privacy-compromising, aggressive rate limits.
*   **BSC (Binance Public):** 10k requests / 5 mins. Good for fallback but not primarily high-frequency.
*   **Polygon (Polygon-RPC):** Often congested.

---

## Detailed Breakdown by Blockchain

### 1. Ethereum Mainnet
*   **Best Free Providers:** Alchemy (30M CUs), Infura (100k req/day), QuickNode (10M credits), Ankr.
*   **Public Free:** `https://eth.llamarpc.com`, `https://rpc.ankr.com/eth`.
*   **Rotation Strategy:** Combine Alchemy + Infura + QuickNode + Ankr. Use LlamaRPC only as a last resort backup.

### 2. Arbitrum One
*   **Best Free Providers:** Alchemy (30M CUs), QuickNode, Infura, Ankr.
*   **Public Free:** `https://arb1.arbitrum.io/rpc`.
*   **Rotation Strategy:** High throughput is needed for L2s. Cluster 2-3 paid-free-tier providers.

### 3. BSC (Binance Smart Chain)
*   **Best Free Providers:** QuickNode, Ankr, GetBlock (limited free tier). **Note:** Alchemy & Infura support for BSC is limited or non-standard in free tiers compared to ETH.
*   **Public Free:** `https://bsc-dataseed1.binance.org` (Official).
*   **Rotation Strategy:** Rely heavily on Official/Public nodes + QuickNode + Ankr.

### 4. Base
*   **Best Free Providers:** Alchemy, QuickNode, Ankr.
*   **Public Free:** `https://mainnet.base.org`.
*   **Rotation Strategy:** Alchemy is very strong on Base. Combine with QuickNode.

### 5. Polygon (Matic)
*   **Best Free Providers:** Alchemy, Infura, QuickNode, Ankr.
*   **Public Free:** `https://polygon-rpc.com`.
*   **Rotation Strategy:** Polygon public RPCs are notoriously flaky. **Must** use a cluster of Alchemy/Infura/QuickNode keys.

### 6. Optimism
*   **Best Free Providers:** Alchemy, Infura, QuickNode, Ankr.
*   **Public Free:** `https://mainnet.optimism.io`.
*   **Rotation Strategy:** Similar to Arbitrum. Alchemy + Infura + QuickNode.

### 7. Avalanche C-Chain
*   **Best Free Providers:** Alchemy, Infura, QuickNode, Ankr.
*   **Public Free:** `https://api.avax.network/ext/bc/C/rpc`.
*   **Rotation Strategy:** Infura & Alchemy both support solid free tiers.

### 8. Fantom
*   **Best Free Providers:** Alchemy (Partnered with Fantom), QuickNode, Ankr.
*   **Public Free:** `https://rpc.ftm.tools`.
*   **Rotation Strategy:** Alchemy is the premier choice here due to partnership.

### 9. zkSync Era
*   **Best Free Providers:** Alchemy, QuickNode, Infura (DIN), Ankr.
*   **Public Free:** `https://mainnet.era.zksync.io`.
*   **Rotation Strategy:** Alchemy + QuickNode.

### 10. Linea
*   **Best Free Providers:** Infura (ConsenSys native), Alchemy, QuickNode, Ankr.
*   **Public Free:** `https://rpc.linea.build`.
*   **Rotation Strategy:** Infura is likely best performing (ConsenSys built Linea). Combine with Alchemy.

---

## 3. Timeout & Ban Policies

*   **Rate Limit (429):**
    *   **Behavior:** Immediate rejection of request.
    *   **Retry Strategy:** Implement **Exponential Backoff** (1s, 2s, 4s...). Do not spam retries or you risk an IP ban.
    *   **Rotation:** On receiving a 429, **immediately rotate** to the next provider in the cluster for the remainder of the minute/second window.

*   **Daily/Monthly Limit (402/403):**
    *   **Behavior:** Requests fail with "Payment Required" or "Quota Exceeded".
    *   **Suspension:** Usually lasts until the reset cycle (Midnight UTC for Daily; 1st of month for Monthly).
    *   **Strategy:** Mark provider as "Depleted" until reset time and remove from rotation pool.

## 4. Evaluation & Conclusion: The "Clustered Rotation" Strategy

To achieve a "break/rate-limit free" experience without paying:

1.  **Orchestrator Pattern:** Implement an `RPCManager` that holds a pool of endpoints for each chain.
2.  **Tiered Priority:**
    *   **Tier 1 (High Reliability):** Alchemy, Infura, QuickNode (Free Tiers).
    *   **Tier 2 (Fallback):** Ankr, Public/Official Endpoints.
3.  **Smart Rotation:**
    *   Round-robin is okay, but **Latency-based routing** with **Error-triggered rotation** is better.
    *   If Provider A returns 429, switch to Provider B immediately.
    *   Track "Used Credits" locally if possible to predict exhaustion, or react to specific error codes indicating quota reached.

**Recommended Cluster per Chain:**

| Blockchain | Primary (Free Keys) | Secondary (Free Keys) | Fallback (Public) |
| :--- | :--- | :--- | :--- |
| **Ethereum** | Alchemy, Infura | QuickNode, Ankr | LlamaRPC |
| **Arbitrum** | Alchemy | Infura, QuickNode | Official |
| **BSC** | QuickNode | Ankr | Official Binance |
| **Base** | Alchemy | QuickNode, Ankr | Official Base |
| **Polygon** | Alchemy, Infura | QuickNode | Polygon Public |
| **Optimism** | Alchemy, Infura | QuickNode | Official OP |
| **Avalanche** | Alchemy, Infura | QuickNode | Official Avax |
| **Fantom** | Alchemy | QuickNode | FTM Tools |
| **zkSync** | Alchemy | Infura, QuickNode | Official zkSync |
| **Linea** | Infura | Alchemy, QuickNode | Official Linea |

**Conclusion:** By registering free accounts for Alchemy, Infura, and QuickNode, you can aggregate ~43M monthly credits/CUs and effectively 500+ RPS burst capacity per chain (combined), which is sufficient for robust arbitrage monitoring in a development/moderate production environment.
