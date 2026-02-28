/**
 * URL Utilities
 *
 * Functions for safe URL handling, including API key masking to prevent
 * credential leakage in logs, error messages, health endpoints, and events.
 *
 * @module utils/url-utils
 * @see P1-6 in docs/reports/P1_DATA_FLOW_DEEP_ANALYSIS_2026-02-28.md
 */

/**
 * Regex matching URL path segments that look like API keys (12+ alphanumeric chars).
 * RPC providers embed keys in URL paths:
 *   - Alchemy: /v2/abcdef1234567890
 *   - Ankr:    /eth/abc123longkey
 *   - Infura:  /v3/abcdef1234567890
 */
const KEY_PATH_PATTERN = /\/([a-zA-Z0-9_-]{12,})/g;

/** Regex matching query parameter names that commonly hold auth tokens. */
const AUTH_PARAM_PATTERN = /[?&](key|token|secret|auth|api_key)=/i;

/**
 * Mask API keys in a URL for safe inclusion in logs, errors, and diagnostics.
 *
 * Handles two key-embedding patterns used by RPC providers:
 * 1. **Path segments**: `/v2/abcdef1234567890abcdef` → `/v2/abcde...`
 * 2. **Query parameters**: `?key=secret123` → `?key=***`
 *
 * URLs without key-like segments are returned unchanged (fast path).
 *
 * @example
 * maskUrlApiKeys('wss://eth-mainnet.g.alchemy.com/v2/abcdef1234567890')
 * // → 'wss://eth-mainnet.g.alchemy.com/v2/abcde...'
 *
 * maskUrlApiKeys('https://rpc.ankr.com/eth/abc123longkey')
 * // → 'https://rpc.ankr.com/eth/abc12...'
 *
 * maskUrlApiKeys('wss://test.com')
 * // → 'wss://test.com' (unchanged)
 */
export function maskUrlApiKeys(url: string): string {
  // Fast path: skip if nothing to mask
  if (!KEY_PATH_PATTERN.test(url) && !AUTH_PARAM_PATTERN.test(url)) {
    return url;
  }

  // Reset lastIndex after test() (global regex)
  KEY_PATH_PATTERN.lastIndex = 0;

  try {
    const parsed = new URL(url);

    // Mask path segments that look like API keys
    parsed.pathname = parsed.pathname.replace(
      KEY_PATH_PATTERN,
      (_, key: string) => `/${key.slice(0, 5)}...`
    );

    // Mask query-string auth tokens
    for (const [key] of parsed.searchParams) {
      if (/key|token|secret|auth|api/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }

    return parsed.toString();
  } catch {
    // If URL parsing fails (malformed URL), mask conservatively with regex
    return url.replace(KEY_PATH_PATTERN, (_, key: string) => `/${key.slice(0, 5)}...`);
  }
}
