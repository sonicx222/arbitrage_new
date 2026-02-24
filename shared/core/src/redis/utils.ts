/**
 * Shared Redis Utilities
 *
 * Extracted from redis/client.ts and redis/streams.ts where
 * resolveRedisPassword() was duplicated byte-for-byte.
 *
 * @module redis/utils
 */

/**
 * Resolve Redis password from explicit parameter or environment variable.
 * Returns undefined if no valid password is available (empty/whitespace-only
 * values are treated as absent).
 */
export function resolveRedisPassword(password?: string): string | undefined {
  const raw = password ?? process.env.REDIS_PASSWORD;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
