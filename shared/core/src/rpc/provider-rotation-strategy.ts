/**
 * Provider Rotation Strategy
 *
 * CQ8-ALT: Extracted cold-path provider rotation logic from websocket-manager.ts.
 * Handles:
 * - Provider URL selection and fallback ordering
 * - Budget-aware and health-scored provider selection
 * - Rate limit detection and provider exclusion tracking
 * - Reconnection delay calculation (exponential backoff with jitter)
 *
 * Performance Note:
 * - All methods here are COLD PATH — called only during reconnection or provider rotation
 * - HOT PATH message handling (handleMessage, processMessage, parseMessageSync,
 *   parseMessageInWorker) remains monolithic in WebSocketManager
 *
 * @see websocket-manager.ts (consumer)
 */

import { createLogger } from '../logger';
import { type ProviderHealthScorer, getProviderHealthScorer } from '../monitoring/provider-health-scorer';
import { recordRpcCall, recordRpcError } from './rpc-metrics';

const logger = createLogger('provider-rotation');

// =============================================================================
// Types
// =============================================================================

export interface ProviderRotationConfig {
  /** Primary URL */
  url: string;
  /** Fallback URLs to try if primary fails */
  fallbackUrls?: string[];
  /** Chain ID for health tracking */
  chainId?: string;
  /** Base reconnect interval in ms (default: 1000) */
  reconnectInterval?: number;
  /** Multiplier for exponential backoff (default: 2.0) */
  backoffMultiplier?: number;
  /** Maximum reconnect delay in ms (default: 60000) */
  maxReconnectDelay?: number;
  /** Jitter percentage to add randomness (default: 0.25 = 25%) */
  jitterPercent?: number;
}

// =============================================================================
// ProviderRotationStrategy
// =============================================================================

/**
 * Manages provider URL rotation, fallback selection, and exclusion tracking.
 *
 * Extracted from WebSocketManager as a cold-path concern.
 * WebSocketManager holds a direct reference to this class (Constructor DI).
 */
export class ProviderRotationStrategy {
  /** All available URLs (primary + fallbacks) */
  private allUrls: string[];
  /** Current URL index being used */
  private currentUrlIndex = 0;
  /** Chain ID for health tracking */
  private readonly chainId: string;

  /**
   * S3.3: Rate limit exclusion tracking.
   * Maps URL to exclusion info { until: timestamp, count: consecutive rate limits }
   */
  private excludedProviders: Map<string, { until: number; count: number }> = new Map();

  /** S3.3: Provider health scorer for intelligent fallback selection */
  private readonly healthScorer: ProviderHealthScorer;

  /** S3.3: Whether to use intelligent fallback selection (default true) */
  private useIntelligentFallback = true;

  /** Whether to use budget-aware provider selection (6-Provider Shield) */
  private useBudgetAwareSelection = true;

  /** Reconnection config */
  private readonly reconnectInterval: number;
  private readonly backoffMultiplier: number;
  private readonly maxReconnectDelay: number;
  private readonly jitterPercent: number;

  constructor(config: ProviderRotationConfig) {
    this.chainId = config.chainId ?? 'unknown';
    this.healthScorer = getProviderHealthScorer();

    // Build list of all URLs (primary + fallbacks)
    this.allUrls = [config.url];
    if (config.fallbackUrls && config.fallbackUrls.length > 0) {
      this.allUrls.push(...config.fallbackUrls);
    }
    this.currentUrlIndex = 0;

    // Backoff config
    this.reconnectInterval = config.reconnectInterval ?? 1000;
    this.backoffMultiplier = config.backoffMultiplier ?? 2.0;
    this.maxReconnectDelay = config.maxReconnectDelay ?? 60000;
    this.jitterPercent = config.jitterPercent ?? 0.25;
  }

  // ===========================================================================
  // URL Access
  // ===========================================================================

  /**
   * Get the current active URL.
   */
  getCurrentUrl(): string {
    return this.allUrls[this.currentUrlIndex] ?? this.allUrls[0];
  }

  /**
   * Get current URL index.
   */
  getCurrentUrlIndex(): number {
    return this.currentUrlIndex;
  }

  /**
   * Get total number of available URLs.
   */
  getTotalUrls(): number {
    return this.allUrls.length;
  }

  /**
   * Reset current URL index to primary (index 0).
   */
  resetToFirstUrl(): void {
    this.currentUrlIndex = 0;
  }

  // ===========================================================================
  // Provider Name Extraction
  // ===========================================================================

  /**
   * Extract provider name from URL for budget tracking.
   * Maps common provider URL patterns to their names.
   */
  extractProviderFromUrl(url: string): string {
    const lowerUrl = url.toLowerCase();

    // Check for API-key providers (more specific patterns first)
    if (lowerUrl.includes('drpc.org') || lowerUrl.includes('lb.drpc.org')) return 'drpc';
    if (lowerUrl.includes('ankr.com') || lowerUrl.includes('rpc.ankr.com')) return 'ankr';
    if (lowerUrl.includes('publicnode.com')) return 'publicnode';
    if (lowerUrl.includes('infura.io')) return 'infura';
    if (lowerUrl.includes('alchemy.com') || lowerUrl.includes('alchemyapi.io')) return 'alchemy';
    if (lowerUrl.includes('quicknode') || lowerUrl.includes('quiknode')) return 'quicknode';
    if (lowerUrl.includes('blastapi.io')) return 'blastapi';

    // Chain-specific RPCs
    if (lowerUrl.includes('1rpc.io')) return '1rpc';
    if (lowerUrl.includes('llamarpc.com')) return 'llamarpc';
    if (lowerUrl.includes('binance.org')) return 'binance';
    if (lowerUrl.includes('arbitrum.io')) return 'arbitrum-official';
    if (lowerUrl.includes('optimism.io')) return 'optimism-official';
    if (lowerUrl.includes('base.org')) return 'base-official';
    if (lowerUrl.includes('polygon-rpc.com')) return 'polygon-official';

    // Solana-specific
    if (lowerUrl.includes('helius')) return 'helius';
    if (lowerUrl.includes('triton')) return 'triton';
    if (lowerUrl.includes('solana.com') || lowerUrl.includes('mainnet-beta.solana')) return 'solana-official';

    return 'unknown';
  }

  // ===========================================================================
  // Fallback Selection
  // ===========================================================================

  /**
   * S3.3: Select the best available fallback URL using health scoring.
   * Updated with budget-aware selection from 6-Provider Shield.
   * Falls back to round-robin if all candidates have similar scores.
   *
   * @returns The best available URL or null if all are excluded
   */
  selectBestFallbackUrl(): string | null {
    const currentUrl = this.getCurrentUrl();

    // Get available (non-excluded) candidates excluding current
    const candidates = this.allUrls.filter(url =>
      url !== currentUrl && !this.isProviderExcluded(url)
    );

    if (candidates.length === 0) {
      logger.warn('No available fallback URLs', { chainId: this.chainId });
      return null;
    }

    if (!this.useIntelligentFallback || candidates.length === 1) {
      return candidates[0];
    }

    // Use budget-aware selection if enabled (6-Provider Shield)
    if (this.useBudgetAwareSelection) {
      const selectedUrl = this.healthScorer.selectBestProviderWithBudget(
        this.chainId,
        candidates,
        (url) => this.extractProviderFromUrl(url)
      );

      logger.info('Selected best fallback URL via budget-aware scoring', {
        chainId: this.chainId,
        selectedUrl,
        provider: this.extractProviderFromUrl(selectedUrl),
        candidateCount: candidates.length,
        score: this.healthScorer.getHealthScore(selectedUrl, this.chainId)
      });

      return selectedUrl;
    }

    // Use health scorer for intelligent selection
    const selectedUrl = this.healthScorer.selectBestProvider(this.chainId, candidates);

    logger.info('Selected best fallback URL via health scoring', {
      chainId: this.chainId,
      selectedUrl,
      candidateCount: candidates.length,
      score: this.healthScorer.getHealthScore(selectedUrl, this.chainId)
    });

    return selectedUrl;
  }

  /**
   * Switch to the next fallback URL, using intelligent selection.
   * Returns true if there's another URL to try, false if we've exhausted all options.
   */
  switchToNextUrl(): boolean {
    const startIndex = this.currentUrlIndex;

    // Try intelligent selection first
    const bestUrl = this.selectBestFallbackUrl();
    if (bestUrl) {
      const newIndex = this.allUrls.indexOf(bestUrl);
      if (newIndex !== -1 && newIndex !== startIndex) {
        this.currentUrlIndex = newIndex;
        logger.info(`Switching to fallback URL ${this.currentUrlIndex}: ${this.getCurrentUrl()}`);
        return true;
      }
    }

    // Fallback to sequential search if intelligent selection fails
    for (let i = 1; i <= this.allUrls.length; i++) {
      const nextIndex = (startIndex + i) % this.allUrls.length;
      const nextUrl = this.allUrls[nextIndex];

      // Skip excluded providers
      if (this.isProviderExcluded(nextUrl)) {
        continue;
      }

      // Found a valid URL
      if (nextIndex !== startIndex) {
        this.currentUrlIndex = nextIndex;
        logger.info(`Switching to fallback URL ${this.currentUrlIndex}: ${this.getCurrentUrl()}`);
        return true;
      }
    }

    // All URLs are either exhausted or excluded
    // Reset to primary URL for next reconnection cycle (it may become available)
    this.currentUrlIndex = 0;
    return false;
  }

  // ===========================================================================
  // Provider Exclusion (Rate Limiting)
  // ===========================================================================

  /**
   * S3.3: Check if a provider URL is currently excluded due to rate limiting.
   */
  isProviderExcluded(url: string): boolean {
    const exclusion = this.excludedProviders.get(url);
    if (!exclusion) return false;

    // Check if exclusion has expired
    if (Date.now() > exclusion.until) {
      this.excludedProviders.delete(url);
      return false;
    }

    return true;
  }

  /**
   * S3.3: Handle rate limit detection by excluding the provider temporarily.
   * Uses exponential backoff for exclusion duration (30s, 60s, 120s, 240s, max 5min).
   */
  handleRateLimit(url: string): void {
    const existing = this.excludedProviders.get(url);
    const count = (existing?.count ?? 0) + 1;

    // Exponential exclusion: 30s * 2^(count-1), max 5 minutes
    const baseExcludeMs = 30000;
    const excludeMs = Math.min(baseExcludeMs * Math.pow(2, count - 1), 300000);

    this.excludedProviders.set(url, {
      until: Date.now() + excludeMs,
      count
    });

    // Phase 6: Record rate limit error metric
    const provider = this.extractProviderFromUrl(url);
    recordRpcError(provider, this.chainId, 'rate_limit');

    logger.warn('Rate limit detected, excluding provider', {
      url,
      chainId: this.chainId,
      excludeMs,
      consecutiveRateLimits: count
    });
  }

  /**
   * Get the count of currently available (non-excluded) providers.
   */
  getAvailableProviderCount(): number {
    return this.allUrls.filter(url => !this.isProviderExcluded(url)).length;
  }

  /**
   * Get all excluded providers for diagnostics.
   */
  getExcludedProviders(): Map<string, { until: number; count: number }> {
    // Clean up expired exclusions first
    for (const [url, exclusion] of this.excludedProviders) {
      if (Date.now() > exclusion.until) {
        this.excludedProviders.delete(url);
      }
    }
    return new Map(this.excludedProviders);
  }

  /**
   * Clear all provider exclusions (useful for recovery/reset).
   */
  clearProviderExclusions(): void {
    this.excludedProviders.clear();
    logger.info('Cleared all provider exclusions', { chainId: this.chainId });
  }

  // ===========================================================================
  // Rate Limit Detection
  // ===========================================================================

  /**
   * S3.3: Check if an error indicates rate limiting by the RPC provider.
   * Detects common rate limit patterns from various providers.
   */
  isRateLimitError(error: any): boolean {
    if (!error) return false;

    const message = (error?.message || '').toLowerCase();
    const code = error?.code;

    // JSON-RPC rate limit error codes
    if (code === -32005 || code === -32016) return true;

    // WebSocket close codes
    if (code === 1008 || code === 1013) return true;

    // HTTP status code equivalents
    if (code === 429) return true;

    // Message pattern matching for various providers
    const rateLimitPatterns = [
      'rate limit',
      'rate-limit',
      'ratelimit',
      'too many requests',
      'request limit exceeded',
      'quota exceeded',
      'throttled',
      'exceeded the limit',
      'limit exceeded',
      'capacity exceeded',
      'try again later',
      'too many concurrent',
      'request per second',
      'requests per second'
    ];

    return rateLimitPatterns.some(pattern => message.includes(pattern));
  }

  // ===========================================================================
  // Reconnection Delay
  // ===========================================================================

  /**
   * Calculate reconnection delay using exponential backoff with jitter.
   * Formula: min(baseDelay * (multiplier ^ attempt), maxDelay) + random jitter
   *
   * This prevents thundering herd problems where all clients reconnect simultaneously.
   *
   * @param attempt - Current reconnection attempt number (0-based)
   * @returns Delay in milliseconds before next reconnection attempt
   */
  calculateReconnectDelay(attempt: number): number {
    // Exponential backoff: baseDelay * (multiplier ^ attempt)
    let delay = this.reconnectInterval * Math.pow(this.backoffMultiplier, attempt);

    // Cap at maximum delay
    delay = Math.min(delay, this.maxReconnectDelay);

    // Add jitter to prevent thundering herd (0 to jitterPercent of delay)
    const jitter = delay * this.jitterPercent * Math.random();

    return Math.floor(delay + jitter);
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Enable or disable intelligent fallback selection.
   */
  setIntelligentFallback(enabled: boolean): void {
    this.useIntelligentFallback = enabled;
  }

  /**
   * Enable or disable budget-aware provider selection.
   */
  setBudgetAwareSelection(enabled: boolean): void {
    this.useBudgetAwareSelection = enabled;
  }

  // ===========================================================================
  // Budget & Health Scorer Access
  // ===========================================================================

  /**
   * Record a request for budget tracking.
   */
  recordRequestForBudget(method = 'eth_subscribe'): void {
    const currentUrl = this.getCurrentUrl();
    const providerName = this.extractProviderFromUrl(currentUrl);
    this.healthScorer.recordRequest(providerName, method);
  }

  /**
   * Get the current provider name for the active connection.
   */
  getCurrentProvider(): string {
    return this.extractProviderFromUrl(this.getCurrentUrl());
  }

  /**
   * Get provider priority order based on time of day and budget status.
   */
  getTimeBasedProviderPriority(): string[] {
    return this.healthScorer.getTimeBasedProviderPriority();
  }

  /**
   * Get health scorer for direct access (used by WebSocketManager for recording).
   */
  getHealthScorer(): ProviderHealthScorer {
    return this.healthScorer;
  }

  // ===========================================================================
  // Prometheus Metrics (Phase 6)
  // ===========================================================================

  /**
   * Record an RPC call for the current provider.
   * Call this from WebSocketManager or RPC callers on each request.
   */
  recordRpcCallMetric(): void {
    const provider = this.getCurrentProvider();
    recordRpcCall(provider, this.chainId);
  }

  /**
   * Record an RPC error for the current provider.
   */
  recordRpcErrorMetric(errorType: string): void {
    const provider = this.getCurrentProvider();
    recordRpcError(provider, this.chainId, errorType);
  }
}
