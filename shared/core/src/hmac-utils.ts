/**
 * HMAC Utility Functions for Redis Data Integrity
 *
 * Provides HMAC-SHA256 signing and verification for arbitrary JSON data
 * stored in Redis. Used to protect bridge recovery states and other
 * critical Redis keys from tampering.
 *
 * When STREAM_SIGNING_KEY is configured, data is signed on write and
 * verified on read. When no key is configured (dev mode), signing
 * is disabled and verification always passes.
 *
 * @custom:version 1.0.0
 * @see redis-streams.ts for Redis Streams HMAC signing (separate mechanism)
 */

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Wrapper envelope for HMAC-signed data in Redis.
 */
export interface SignedEnvelope<T> {
  /** The original data payload */
  data: T;
  /** HMAC-SHA256 signature of the serialized data */
  sig: string;
}

/**
 * Get the HMAC signing key from environment.
 * Returns null if no key is configured (dev mode).
 */
export function getHmacSigningKey(): string | null {
  const raw = process.env.STREAM_SIGNING_KEY;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Sign a data object with HMAC-SHA256.
 * Returns a SignedEnvelope containing the original data and its signature.
 * If no signing key is provided, returns an envelope with empty signature.
 *
 * @param data - The data to sign
 * @param signingKey - HMAC signing key (null = no signing)
 * @param context - Optional context (e.g. Redis key) included in HMAC to prevent cross-key replay
 */
export function hmacSign<T>(data: T, signingKey: string | null, context?: string): SignedEnvelope<T> {
  if (!signingKey) {
    return { data, sig: '' };
  }

  const hmac = createHmac('sha256', signingKey);
  if (context) {
    hmac.update(context);
    hmac.update('\0'); // Null separator to prevent context+data ambiguity
  }
  const sig = hmac.update(JSON.stringify(data)).digest('hex');
  return { data, sig };
}

/**
 * Verify an HMAC-signed envelope and extract the data.
 * Returns the original data if verification passes, null if it fails.
 * If no signing key is provided (dev mode), returns data without verification.
 *
 * @param envelope - The signed envelope to verify
 * @param signingKey - HMAC signing key (null = skip verification)
 * @param context - Optional context (e.g. Redis key) that was included in HMAC during signing
 */
export function hmacVerify<T>(envelope: SignedEnvelope<T>, signingKey: string | null, context?: string): T | null {
  if (!signingKey) {
    return envelope.data;
  }

  if (!envelope.sig) {
    // Data not signed but signing is enabled — reject
    return null;
  }

  const hmac = createHmac('sha256', signingKey);
  if (context) {
    hmac.update(context);
    hmac.update('\0');
  }
  const expected = hmac.update(JSON.stringify(envelope.data)).digest('hex');

  if (expected.length !== envelope.sig.length) {
    return null;
  }

  const isValid = timingSafeEqual(Buffer.from(expected), Buffer.from(envelope.sig));
  return isValid ? envelope.data : null;
}

/**
 * Check if a raw Redis value looks like a signed envelope.
 * Used to distinguish signed vs unsigned data during migration.
 */
export function isSignedEnvelope(value: unknown): value is SignedEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'sig' in value &&
    typeof (value as SignedEnvelope<unknown>).sig === 'string'
  );
}
