/**
 * Jupiter V6 Swap Client
 *
 * Provides a typed client for Jupiter's V6 aggregator API, used for
 * Solana-native arbitrage execution. Handles quote fetching and swap
 * transaction generation.
 *
 * Jupiter is the leading DEX aggregator on Solana, routing across 30+ DEXs.
 *
 * @see https://station.jup.ag/docs/apis/swap-api
 * @see Phase 3 #29: Solana Execution with Jito Bundles
 */

import { createLogger, type Logger } from '@arbitrage/core';

// =============================================================================
// Types
// =============================================================================

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: Array<{
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
    percent: number;
  }>;
}

export interface JupiterSwapResult {
  /** Base64-encoded versioned transaction */
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export interface JupiterClientConfig {
  /** Jupiter V6 API base URL */
  apiUrl: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Default slippage tolerance in basis points */
  defaultSlippageBps: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: JupiterClientConfig = {
  apiUrl: 'https://quote-api.jup.ag/v6',
  timeoutMs: 10000,
  maxRetries: 2,
  defaultSlippageBps: 50,
};

// =============================================================================
// Jupiter Swap Client
// =============================================================================

/**
 * Client for Jupiter V6 DEX aggregator API.
 *
 * Handles:
 * - Quote fetching with slippage tolerance
 * - Swap transaction generation (base64-encoded versioned transactions)
 * - Retry with exponential backoff on transient failures
 * - Request timeout via AbortController
 */
export class JupiterSwapClient {
  private readonly config: JupiterClientConfig;
  private readonly logger: Logger;

  constructor(config?: Partial<JupiterClientConfig>, logger?: Logger) {
    this.config = {
      apiUrl: config?.apiUrl ?? DEFAULT_CONFIG.apiUrl,
      timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      maxRetries: config?.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      defaultSlippageBps: config?.defaultSlippageBps ?? DEFAULT_CONFIG.defaultSlippageBps,
    };
    this.logger = logger ?? createLogger('jupiter-client');
  }

  /**
   * Get a swap quote from Jupiter.
   *
   * @param inputMint - SPL token mint address for input token
   * @param outputMint - SPL token mint address for output token
   * @param amount - Input amount in smallest unit (lamports for SOL)
   * @param slippageBps - Slippage tolerance in basis points (optional, uses default)
   * @returns Jupiter quote with route plan and expected output
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps?: number,
  ): Promise<JupiterQuote> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps: String(slippageBps ?? this.config.defaultSlippageBps),
    });

    const url = `${this.config.apiUrl}/quote?${params.toString()}`;

    this.logger.debug('Fetching Jupiter quote', {
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps ?? this.config.defaultSlippageBps,
    });

    const data = await this.fetchWithRetry<JupiterQuote>(url, { method: 'GET' });

    // Validate critical fields — Jupiter API may return unexpected shapes on error
    if (!data.inAmount || !data.outAmount) {
      throw new Error(
        `Jupiter quote response missing required fields: inAmount=${data.inAmount}, outAmount=${data.outAmount}`,
      );
    }

    this.logger.debug('Jupiter quote received', {
      inAmount: data.inAmount,
      outAmount: data.outAmount,
      priceImpactPct: data.priceImpactPct,
      routeSteps: data.routePlan?.length ?? 0,
    });

    return data;
  }

  /**
   * Get a swap transaction from Jupiter.
   *
   * Takes a quote response and user's public key, returns a base64-encoded
   * versioned transaction ready for signing.
   *
   * @param quoteResponse - Quote from getQuote()
   * @param userPublicKey - Wallet public key (base58 string)
   * @returns Swap result with base64-encoded transaction
   */
  async getSwapTransaction(
    quoteResponse: JupiterQuote,
    userPublicKey: string,
  ): Promise<JupiterSwapResult> {
    const url = `${this.config.apiUrl}/swap`;

    this.logger.debug('Fetching Jupiter swap transaction', {
      userPublicKey,
      inAmount: quoteResponse.inAmount,
      outAmount: quoteResponse.outAmount,
    });

    const data = await this.fetchWithRetry<JupiterSwapResult>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });

    // Validate critical fields — missing swapTransaction means Jupiter couldn't build the tx
    if (!data.swapTransaction) {
      throw new Error('Jupiter swap response missing swapTransaction field');
    }

    this.logger.debug('Jupiter swap transaction received', {
      lastValidBlockHeight: data.lastValidBlockHeight,
      txLength: data.swapTransaction.length,
    });

    return data;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Fetch with retry and exponential backoff.
   *
   * Retry delay: attempt * 1000ms (1s, 2s, 3s, ...)
   * Timeout: AbortController with configured timeoutMs
   */
  private async fetchWithRetry<T>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeoutMs,
        );

        try {
          const response = await fetch(url, {
            ...init,
            signal: controller.signal,
          });

          if (!response.ok) {
            const body = await response.text().catch(() => 'unknown');
            throw new Error(
              `Jupiter API error: ${response.status} ${response.statusText} - ${body}`,
            );
          }

          const data = (await response.json()) as T;
          return data;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = (attempt + 1) * 1000;
          this.logger.warn('Jupiter API request failed, retrying', {
            attempt: attempt + 1,
            maxRetries: this.config.maxRetries,
            delayMs: delay,
            error: lastError.message,
            url,
          });
          await this.sleep(delay);
        }
      }
    }

    this.logger.error('Jupiter API request failed after all retries', {
      maxRetries: this.config.maxRetries,
      error: lastError?.message,
      url,
    });

    throw lastError ?? new Error('Jupiter API request failed');
  }

  /**
   * Sleep helper for retry backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
