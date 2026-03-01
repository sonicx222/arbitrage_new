/**
 * Environment Validation for P4 Solana-Native Partition
 *
 * Validates required environment variables early to fail fast.
 * Extracted from index.ts for separation of concerns.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import { exitWithConfigError } from '@arbitrage/core/partition';
import { createLogger } from '@arbitrage/core';

// =============================================================================
// Environment Validation
// =============================================================================

/**
 * Validates required environment variables for the partition service.
 *
 * CRITICAL-FIX: Validate required environment variables early to fail fast.
 * P2-FIX: Using shared exitWithConfigError from @arbitrage/core.
 *
 * Validates:
 * - REDIS_URL is present (required for all partition services)
 * - REDIS_URL has a valid protocol (redis://, rediss://, redis+sentinel://)
 *
 * Skips validation when NODE_ENV is 'test' to allow test imports.
 *
 * @param partitionId - The partition identifier for error context
 * @param logger - Logger instance for error reporting
 */
export function validateEnvironment(partitionId: string, logger: ReturnType<typeof createLogger>): void {
  const nodeEnv = process.env.NODE_ENV;
  const redisUrl = process.env.REDIS_URL;

  // FIX #9: Warn when SOLANA_RPC_URL is missing in dev mode (falls back to PublicNode)
  // P2-6 FIX: Only warn when no API key alternatives are set either.
  // Previously this warned even when HELIUS_API_KEY was set (which provides
  // a non-public endpoint), creating a misleading "PublicNode fallback" message.
  if (!process.env.SOLANA_RPC_URL && !process.env.HELIUS_API_KEY && !process.env.TRITON_API_KEY
      && nodeEnv !== 'test' && nodeEnv !== 'production') {
    logger.warn('SOLANA_RPC_URL not set — using PublicNode fallback (rate-limited, not for production)', {
      partitionId,
      hint: 'Set SOLANA_RPC_URL for better reliability, or use HELIUS_API_KEY/TRITON_API_KEY',
    });
  }

  // Validate REDIS_URL - required for all partition services
  // P3-FIX: Also validate URL format to catch configuration errors early
  if (!redisUrl && nodeEnv !== 'test') {
    exitWithConfigError('REDIS_URL environment variable is required', {
      partitionId,
      hint: 'Set REDIS_URL=redis://localhost:6379 for local development'
    }, logger);
  } else if (redisUrl && nodeEnv !== 'test') {
    // Validate REDIS_URL format
    const validRedisProtocols = ['redis:', 'rediss:', 'redis+sentinel:'];
    try {
      const url = new URL(redisUrl);
      if (!validRedisProtocols.includes(url.protocol)) {
        exitWithConfigError('REDIS_URL has invalid protocol', {
          partitionId,
          protocol: url.protocol,
          validProtocols: validRedisProtocols,
          hint: 'URL should start with redis:// or rediss://'
        }, logger);
      }
    } catch {
      exitWithConfigError('REDIS_URL is not a valid URL', {
        partitionId,
        // Don't log the actual URL in case it contains credentials
        hint: 'URL should be in format redis://[user:password@]host:port'
      }, logger);
    }
  }
}
