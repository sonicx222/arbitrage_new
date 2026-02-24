/**
 * KMS Signer — AWS KMS Transaction Signing Adapter
 *
 * Wraps AWS KMS behind the ethers.js AbstractSigner interface so that
 * private keys never leave the HSM. The signing key remains in KMS;
 * only signatures are returned over the wire.
 *
 * ## Setup
 *
 * 1. Create an asymmetric signing key in AWS KMS:
 *    - Key spec: ECC_SECG_P256K1 (secp256k1)
 *    - Key usage: SIGN_VERIFY
 *
 * 2. Install optional dependency:
 *    ```bash
 *    npm install @aws-sdk/client-kms
 *    ```
 *
 * 3. Set environment variables:
 *    ```
 *    FEATURE_KMS_SIGNING=true
 *    KMS_KEY_ID=arn:aws:kms:us-east-1:123456:key/abc-123  # or alias
 *    AWS_REGION=us-east-1
 *    # AWS credentials via standard chain (env vars, instance profile, etc.)
 *    ```
 *
 * ## Per-Chain Key Support
 *
 * Each chain can have its own KMS key for isolation:
 * ```
 * KMS_KEY_ID_ETHEREUM=arn:aws:kms:...
 * KMS_KEY_ID_ARBITRUM=arn:aws:kms:...
 * ```
 * Falls back to `KMS_KEY_ID` if no per-chain key is set.
 *
 * ## Architecture
 *
 * KmsSigner extends ethers.AbstractSigner:
 * - `getAddress()`: Derives Ethereum address from KMS public key (cached)
 * - `signTransaction()`: Calls KMS Sign API with ECDSA_SHA_256
 * - `signMessage()`: Calls KMS Sign API on EIP-191 prefixed hash
 * - `connect()`: Returns new signer bound to a different provider
 *
 * @see Phase 2 Item 27: KMS integration for signing
 * @see docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md Section 7.1.1
 */

import { ethers } from 'ethers';
import type { Logger } from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * KMS client interface — abstracts over AWS KMS SDK.
 * Allows mock injection for testing without the AWS SDK.
 */
export interface KmsClient {
  /**
   * Get the public key for a KMS key.
   * @returns DER-encoded public key bytes
   */
  getPublicKey(keyId: string): Promise<Uint8Array>;

  /**
   * Sign a digest using the KMS key.
   * @param keyId - KMS key identifier
   * @param digest - 32-byte hash to sign
   * @returns DER-encoded ECDSA signature
   */
  sign(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

export interface KmsSignerConfig {
  /** KMS key ID (ARN, alias, or key ID) */
  keyId: string;
  /** KMS client instance */
  kmsClient: KmsClient;
  /** ethers.js provider to connect to */
  provider: ethers.Provider;
  /** Logger instance */
  logger: Logger;
  /** Chain name for logging context */
  chainName?: string;
  /** Fix #41: Timeout for KMS API calls in ms (default: 5000) */
  kmsTimeoutMs?: number;
  /** Fix #28: Maximum concurrent KMS signing calls (default: 3). Tune based on KMS rate limits. */
  maxConcurrentSigns?: number;
  /** Fix #12: Maximum sign queue size (default: 100). Rejects with error when full. */
  maxSignQueueSize?: number;
}

/**
 * Minimal runtime shape of @aws-sdk/client-kms used by this module.
 * Keep this local so TypeScript doesn't require the optional dependency
 * to be installed for non-KMS builds.
 */
type AwsKmsSdkModule = {
  KMSClient: new (config: { region: string }) => { send: (command: unknown) => Promise<unknown> };
  GetPublicKeyCommand: new (input: { KeyId: string }) => unknown;
  SignCommand: new (input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: 'DIGEST';
    SigningAlgorithm: 'ECDSA_SHA_256';
  }) => unknown;
};

// =============================================================================
// DER Signature Parsing
// =============================================================================

/**
 * Parse a DER-encoded ECDSA signature into r and s components.
 *
 * DER format:
 *   SEQUENCE { INTEGER r, INTEGER s }
 *   30 <len> 02 <rlen> <r> 02 <slen> <s>
 *
 * @param derSignature - DER-encoded ECDSA signature bytes
 * @returns { r, s } as 32-byte hex strings (0x-prefixed)
 */
function parseDerSignature(derSignature: Uint8Array): { r: string; s: string } {
  // Fix #9: Validate minimum DER signature length (SEQUENCE tag + length + at least 2 INTEGERs)
  // Minimum valid: 30 06 02 01 XX 02 01 XX = 8 bytes
  if (derSignature.length < 8) {
    throw new Error(`Invalid DER signature: too short (${derSignature.length} bytes, minimum 8)`);
  }

  // Validate SEQUENCE tag
  if (derSignature[0] !== 0x30) {
    throw new Error('Invalid DER signature: missing SEQUENCE tag');
  }

  const seqLen = derSignature[1];
  // Fix #9: Validate SEQUENCE length fits within the buffer
  if (seqLen + 2 > derSignature.length) {
    throw new Error(`Invalid DER signature: SEQUENCE length ${seqLen} exceeds buffer size ${derSignature.length}`);
  }

  let offset = 2; // Skip SEQUENCE tag + length

  // Parse r
  if (offset >= derSignature.length || derSignature[offset] !== 0x02) {
    throw new Error('Invalid DER signature: missing INTEGER tag for r');
  }
  offset++;
  if (offset >= derSignature.length) {
    throw new Error('Invalid DER signature: truncated before r length');
  }
  const rLen = derSignature[offset];
  offset++;
  if (offset + rLen > derSignature.length) {
    throw new Error(`Invalid DER signature: r length ${rLen} exceeds remaining buffer at offset ${offset}`);
  }
  let r = derSignature.slice(offset, offset + rLen);
  offset += rLen;

  // Parse s
  if (offset >= derSignature.length || derSignature[offset] !== 0x02) {
    throw new Error('Invalid DER signature: missing INTEGER tag for s');
  }
  offset++;
  if (offset >= derSignature.length) {
    throw new Error('Invalid DER signature: truncated before s length');
  }
  const sLen = derSignature[offset];
  offset++;
  if (offset + sLen > derSignature.length) {
    throw new Error(`Invalid DER signature: s length ${sLen} exceeds remaining buffer at offset ${offset}`);
  }
  let s = derSignature.slice(offset, offset + sLen);

  // Strip leading zero bytes (DER encodes as signed integers)
  if (r.length === 33 && r[0] === 0x00) {
    r = r.slice(1);
  }
  if (s.length === 33 && s[0] === 0x00) {
    s = s.slice(1);
  }

  // Pad to 32 bytes if shorter
  if (r.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(r, 32 - r.length);
    r = padded;
  }
  if (s.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(s, 32 - s.length);
    s = padded;
  }

  return {
    r: '0x' + Buffer.from(r).toString('hex'),
    s: '0x' + Buffer.from(s).toString('hex'),
  };
}

/**
 * Parse a DER-encoded SubjectPublicKeyInfo to extract the raw 65-byte
 * uncompressed secp256k1 public key (04 || x || y).
 *
 * Fix #13: Parse DER TLV structures instead of scanning backwards for 0x04.
 * The old heuristic could match a 0x04 byte inside another field.
 *
 * SPKI DER structure:
 *   SEQUENCE {
 *     SEQUENCE { OID(ecPublicKey), OID(secp256k1) },  -- AlgorithmIdentifier
 *     BIT STRING { 0x00, 0x04, x[32], y[32] }         -- subjectPublicKey
 *   }
 *
 * We parse enough TLV to locate the BIT STRING, skip its unused-bits byte,
 * and extract the 65-byte uncompressed key.
 */
function parseSpkiPublicKey(spki: Uint8Array): Uint8Array {
  let offset = 0;

  // Outer SEQUENCE
  if (spki[offset] !== 0x30) {
    throw new Error('Invalid SPKI: expected outer SEQUENCE tag');
  }
  offset++;
  // Skip the outer SEQUENCE length (may be multi-byte)
  offset += parseDerLength(spki, offset).bytesConsumed;

  // Inner SEQUENCE (AlgorithmIdentifier) — skip entirely
  if (spki[offset] !== 0x30) {
    throw new Error('Invalid SPKI: expected AlgorithmIdentifier SEQUENCE tag');
  }
  offset++;
  const algoLen = parseDerLength(spki, offset);
  offset += algoLen.bytesConsumed + algoLen.length;

  // BIT STRING containing the public key
  if (spki[offset] !== 0x03) {
    throw new Error('Invalid SPKI: expected BIT STRING tag');
  }
  offset++;
  const bitStringLen = parseDerLength(spki, offset);
  offset += bitStringLen.bytesConsumed;

  // First byte of BIT STRING content is "unused bits" count (should be 0x00)
  const unusedBits = spki[offset];
  if (unusedBits !== 0x00) {
    throw new Error(`Invalid SPKI: unexpected unused bits byte 0x${unusedBits.toString(16)}`);
  }
  offset++;

  // Remaining bytes are the uncompressed public key (0x04 || x || y)
  const keyBytes = spki.slice(offset, offset + 65);
  if (keyBytes.length !== 65 || keyBytes[0] !== 0x04) {
    throw new Error('Invalid SPKI: expected 65-byte uncompressed public key starting with 0x04');
  }

  return keyBytes;
}

/**
 * Parse a DER length field starting at the given offset.
 * Returns the decoded length value and how many bytes the length field consumed.
 */
function parseDerLength(data: Uint8Array, offset: number): { length: number; bytesConsumed: number } {
  const firstByte = data[offset];
  if (firstByte < 0x80) {
    // Short form: length is the byte itself
    return { length: firstByte, bytesConsumed: 1 };
  }

  // Long form: firstByte & 0x7F is the number of subsequent length bytes
  const numLenBytes = firstByte & 0x7f;
  if (numLenBytes === 0 || numLenBytes > 4) {
    throw new Error(`Invalid DER length: ${numLenBytes} length bytes`);
  }

  let length = 0;
  for (let i = 0; i < numLenBytes; i++) {
    length = (length << 8) | data[offset + 1 + i];
  }

  return { length, bytesConsumed: 1 + numLenBytes };
}

// =============================================================================
// secp256k1 curve order (for s-value normalization)
// =============================================================================

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const SECP256K1_HALF_N = SECP256K1_N / 2n;

// =============================================================================
// KMS Signer Implementation
// =============================================================================

/**
 * ethers.js Signer backed by AWS KMS.
 *
 * The private key never leaves KMS. All signing operations are remote calls.
 * The Ethereum address is derived from the KMS public key and cached.
 */
export class KmsSigner extends ethers.AbstractSigner {
  private readonly keyId: string;
  private readonly kmsClient: KmsClient;
  private readonly _logger: Logger;
  private readonly chainName: string;

  /** Cached Ethereum address (derived from KMS public key on first call) */
  private _cachedAddress: string | null = null;

  /** Fix #32: Pending address derivation promise to prevent concurrent KMS calls */
  private _addressPromise: Promise<string> | null = null;

  /** Fix #41: KMS API call timeout in ms */
  private readonly kmsTimeoutMs: number;

  /** Fix #59: Semaphore for KMS signing concurrency control (AWS KMS per-key rate limits) */
  private pendingSignCalls = 0;
  /** Fix #28: Configurable via constructor config (default: 3). */
  private readonly maxConcurrentSigns: number;
  /** Fix #12: Maximum sign queue size to prevent unbounded accumulation (default: 100). */
  private readonly maxSignQueueSize: number;
  private signQueue: Array<{ resolve: () => void }> = [];

  /** Fix #62: KMS signing metrics */
  private _metrics = {
    signAttempts: 0,
    signSuccesses: 0,
    signFailures: 0,
    totalSignLatencyMs: 0,
    cacheHits: 0,
  };

  /** Fix: Guard to prevent kmsSign() calls after drain() has been initiated */
  private _isDraining = false;

  /** Fix #41: Circuit breaker — consecutive KMS failures */
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;
  /**
   * Fix #22: Align with ADR-018 cooldown of 300s (was 30s, 6x shorter).
   * KMS uses a hand-rolled CB (simpler for signing use case) but timing
   * should be consistent with the system-wide circuit breaker standard.
   */
  private static readonly CIRCUIT_RESET_MS = 300_000;
  private circuitOpenUntil = 0;

  constructor(config: KmsSignerConfig) {
    super(config.provider);
    this.keyId = config.keyId;
    this.kmsClient = config.kmsClient;
    this._logger = config.logger;
    this.chainName = config.chainName ?? 'unknown';
    this.kmsTimeoutMs = config.kmsTimeoutMs ?? 5000;
    this.maxConcurrentSigns = config.maxConcurrentSigns ?? 3;
    this.maxSignQueueSize = config.maxSignQueueSize ?? 100;
  }

  /**
   * Get the Ethereum address derived from the KMS public key.
   * Fix #32: Uses a cached promise to prevent concurrent KMS API calls.
   */
  async getAddress(): Promise<string> {
    if (this._cachedAddress) {
      this._metrics.cacheHits++;
      return this._cachedAddress;
    }

    // Fix #32: Cache the pending promise so concurrent callers share one KMS call
    this._addressPromise ??= this._deriveAddress();
    return this._addressPromise;
  }

  /**
   * Derive the Ethereum address from the KMS public key.
   */
  private async _deriveAddress(): Promise<string> {
    const spki = await this.kmsClient.getPublicKey(this.keyId);
    const uncompressedKey = parseSpkiPublicKey(spki);

    // Derive Ethereum address: keccak256(pubkey[1:65])[-20:]
    // Skip the 0x04 prefix byte
    const pubKeyBytes = uncompressedKey.slice(1);
    const hash = ethers.keccak256(pubKeyBytes);
    this._cachedAddress = ethers.getAddress('0x' + hash.slice(-40));

    this._logger.info('KMS signer address derived', {
      chain: this.chainName,
      address: this._cachedAddress,
      keyId: this.keyId.slice(0, 20) + '...',
    });

    return this._cachedAddress;
  }

  /**
   * Return a new KmsSigner connected to a different provider.
   * Fix #30: Copy cached address to avoid redundant KMS API call on provider switch.
   */
  connect(provider: ethers.Provider | null): KmsSigner {
    const newSigner = new KmsSigner({
      keyId: this.keyId,
      kmsClient: this.kmsClient,
      provider: provider ?? this.provider!,
      logger: this._logger,
      chainName: this.chainName,
      maxConcurrentSigns: this.maxConcurrentSigns,
      maxSignQueueSize: this.maxSignQueueSize,
    });
    newSigner._cachedAddress = this._cachedAddress;
    return newSigner;
  }

  /**
   * Sign a transaction using KMS.
   */
  async signTransaction(tx: ethers.TransactionLike): Promise<string> {
    const unsignedTx = ethers.Transaction.from(tx);
    const digest = ethers.getBytes(ethers.keccak256(unsignedTx.unsignedSerialized));

    const { r, s, v } = await this.kmsSign(digest);

    unsignedTx.signature = ethers.Signature.from({ r, s, v });
    return unsignedTx.serialized;
  }

  /**
   * Sign an EIP-191 personal message using KMS.
   */
  async signMessage(message: string | Uint8Array): Promise<string> {
    const messageHash = ethers.hashMessage(message);
    const digest = ethers.getBytes(messageHash);

    const { r, s, v } = await this.kmsSign(digest);
    return ethers.Signature.from({ r, s, v }).serialized;
  }

  /**
   * Sign EIP-712 typed data using KMS.
   */
  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string> {
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);
    const digest = ethers.getBytes(hash);

    const { r, s, v } = await this.kmsSign(digest);
    return ethers.Signature.from({ r, s, v }).serialized;
  }

  // ===========================================================================
  // Internal KMS Signing
  // ===========================================================================

  /**
   * Sign a 32-byte digest via KMS and recover the v value.
   *
   * KMS returns a DER-encoded signature without recovery ID (v).
   * We try both v=27 and v=28 to find which recovers our address.
   *
   * The s-value is normalized to the lower half of the curve order
   * per EIP-2 to prevent transaction malleability.
   */
  private async kmsSign(digest: Uint8Array): Promise<{ r: string; s: string; v: number }> {
    // Fix: Reject signing attempts after drain() has been called during shutdown.
    // drain() resolves queued callers who would otherwise proceed to use
    // stale nonces or disconnected providers.
    if (this._isDraining) {
      throw new Error(
        '[ERR_KMS_DRAINING] KMS signer is draining — signing rejected during shutdown'
      );
    }

    const signStart = Date.now();
    this._metrics.signAttempts++;

    // Fix #41: Circuit breaker — fail fast if KMS is consistently failing
    if (this.consecutiveFailures >= KmsSigner.MAX_CONSECUTIVE_FAILURES) {
      if (Date.now() < this.circuitOpenUntil) {
        this._metrics.signFailures++;
        throw new Error(
          `[ERR_KMS_CIRCUIT_OPEN] KMS circuit breaker open after ${this.consecutiveFailures} consecutive failures. ` +
          `Resets at ${new Date(this.circuitOpenUntil).toISOString()}`
        );
      }
      // Cooldown expired — allow a probe request
      this._logger.info('KMS circuit breaker probe attempt', { chain: this.chainName });
    }

    // Fix #59: Acquire semaphore before KMS call to prevent rate-limit hits
    await this.acquireSignSlot();

    let derSignature: Uint8Array;
    try {
      // Fix #41: Wrap KMS call with timeout
      derSignature = await this.withTimeout(
        this.kmsClient.sign(this.keyId, digest),
        this.kmsTimeoutMs,
        'KMS sign timeout'
      );
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      this._metrics.signFailures++;
      this._metrics.totalSignLatencyMs += Date.now() - signStart;
      if (this.consecutiveFailures >= KmsSigner.MAX_CONSECUTIVE_FAILURES) {
        this.circuitOpenUntil = Date.now() + KmsSigner.CIRCUIT_RESET_MS;
        this._logger.error('KMS circuit breaker opened', {
          chain: this.chainName,
          consecutiveFailures: this.consecutiveFailures,
          resetMs: KmsSigner.CIRCUIT_RESET_MS,
        });
      }
      this.releaseSignSlot();
      throw error;
    }

    this.releaseSignSlot();

    const { r, s: rawS } = parseDerSignature(derSignature);

    // Normalize s-value to lower half of curve order (EIP-2)
    let sBigInt = BigInt(rawS);
    if (sBigInt > SECP256K1_HALF_N) {
      sBigInt = SECP256K1_N - sBigInt;
    }
    const s = '0x' + sBigInt.toString(16).padStart(64, '0');

    // Recover v by trying both values
    const expectedAddress = await this.getAddress();
    const digestHex = ethers.hexlify(digest);

    for (const v of [27, 28]) {
      try {
        const sig = ethers.Signature.from({ r, s, v });
        const recovered = ethers.recoverAddress(digestHex, sig);
        if (recovered.toLowerCase() === expectedAddress.toLowerCase()) {
          this._metrics.signSuccesses++;
          const signLatencyMs = Date.now() - signStart;
          this._metrics.totalSignLatencyMs += signLatencyMs;
          this._logger.debug('KMS sign completed', { chain: this.chainName, latencyMs: signLatencyMs });
          return { r, s, v };
        }
      } catch {
        // Try next v value
      }
    }

    this._metrics.signFailures++;
    this._metrics.totalSignLatencyMs += Date.now() - signStart;
    throw new Error(
      `[ERR_KMS_RECOVERY] Failed to recover v value for KMS signature. ` +
      `Expected address: ${expectedAddress}, key: ${this.keyId.slice(0, 20)}...`
    );
  }

  /**
   * Fix #59: Acquire a sign slot. Blocks if maxConcurrentSigns are already in flight.
   * Fix #12: Rejects immediately if the sign queue has reached maxSignQueueSize.
   */
  private acquireSignSlot(): Promise<void> {
    if (this.pendingSignCalls < this.maxConcurrentSigns) {
      this.pendingSignCalls++;
      return Promise.resolve();
    }

    // Fix #12: Reject if the queue is full to prevent unbounded memory growth
    if (this.signQueue.length >= this.maxSignQueueSize) {
      return Promise.reject(new Error(
        `[ERR_KMS_QUEUE_FULL] KMS sign queue is full (${this.signQueue.length}/${this.maxSignQueueSize}). ` +
        `Concurrent signs: ${this.pendingSignCalls}/${this.maxConcurrentSigns}`
      ));
    }

    return new Promise<void>((resolve) => {
      this.signQueue.push({ resolve });
    });
  }

  /**
   * Fix #59: Release a sign slot and unblock the next queued caller.
   */
  private releaseSignSlot(): void {
    const next = this.signQueue.shift();
    if (next) {
      // Hand the slot directly to the next queued caller (no decrement/increment)
      next.resolve();
    } else {
      this.pendingSignCalls--;
    }
  }

  /**
   * Fix R4: Drain the sign queue on shutdown by rejecting queued callers.
   * Without this, callers blocked in acquireSignSlot() would hang forever
   * if the service shuts down while they are waiting.
   *
   * Safety note: drain() resolves queued callers rather than rejecting them
   * to avoid unhandled rejection warnings. The resolved callers then proceed
   * to kmsSign(), where the `_isDraining` guard (line 454) throws
   * [ERR_KMS_DRAINING] before any KMS API call is made. This is safe because
   * the rejection happens synchronously at the top of kmsSign(), before any
   * state mutation or external calls.
   */
  drain(): void {
    this._isDraining = true;
    const queued = this.signQueue.splice(0);
    for (const entry of queued) {
      // Resolve → caller proceeds → _isDraining guard in kmsSign() throws.
      // See safety note above for why resolve (not reject) is used here.
      entry.resolve();
    }
    this.pendingSignCalls = 0;
  }

  /**
   * Fix #62: Get KMS signing metrics.
   */
  getSigningMetrics(): typeof this._metrics & { avgSignLatencyMs: number } {
    const avg = this._metrics.signAttempts > 0
      ? this._metrics.totalSignLatencyMs / this._metrics.signAttempts
      : 0;
    return { ...this._metrics, avgSignLatencyMs: avg };
  }

  /**
   * Fix #41: Wrap a promise with a timeout.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[ERR_KMS_TIMEOUT] ${message} after ${timeoutMs}ms`));
      }, timeoutMs);

      promise.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

// =============================================================================
// AWS KMS Client Implementation
// =============================================================================

/**
 * AWS KMS client using the @aws-sdk/client-kms package.
 *
 * Requires: npm install @aws-sdk/client-kms
 *
 * Falls back gracefully if the SDK is not installed — the feature flag
 * check in provider.service.ts prevents this code from being reached
 * unless FEATURE_KMS_SIGNING=true AND the SDK is available.
 */
export class AwsKmsClient implements KmsClient {
  private readonly region: string;
  private _client: unknown = null;
  /** Fix #33: Cache the KMS module reference to avoid repeated module load overhead */
  private _kmsModule: AwsKmsSdkModule | null = null;

  constructor(region?: string) {
    this.region = region ?? process.env.AWS_REGION ?? 'us-east-1';
  }

  /**
   * Fix #33: Load and cache the KMS module alongside the client.
   * Previously, getPublicKey() and sign() each loaded the module separately.
   */
  private async getClientAndModule(): Promise<{
    client: { send: (command: unknown) => Promise<unknown> };
    kmsModule: AwsKmsSdkModule;
  }> {
    if (this._client && this._kmsModule) {
      return {
        client: this._client as { send: (command: unknown) => Promise<unknown> },
        kmsModule: this._kmsModule,
      };
    }

    try {
      // Lazy require keeps AWS SDK optional for builds that don't use KMS signing.
      const kmsModule = require('@aws-sdk/client-kms') as AwsKmsSdkModule;
      this._kmsModule = kmsModule;
      this._client = new kmsModule.KMSClient({ region: this.region });
      return {
        client: this._client as { send: (command: unknown) => Promise<unknown> },
        kmsModule,
      };
    } catch {
      throw new Error(
        '[ERR_KMS_SDK] @aws-sdk/client-kms is not installed. ' +
        'Install it with: npm install @aws-sdk/client-kms'
      );
    }
  }

  async getPublicKey(keyId: string): Promise<Uint8Array> {
    const { client, kmsModule } = await this.getClientAndModule();
    const command = new kmsModule.GetPublicKeyCommand({ KeyId: keyId });
    const response = await client.send(command) as { PublicKey?: Uint8Array };

    if (!response.PublicKey) {
      throw new Error(`[ERR_KMS_NO_KEY] KMS returned no public key for ${keyId}`);
    }

    return new Uint8Array(response.PublicKey);
  }

  async sign(keyId: string, digest: Uint8Array): Promise<Uint8Array> {
    const { client, kmsModule } = await this.getClientAndModule();
    const command = new kmsModule.SignCommand({
      KeyId: keyId,
      Message: digest,
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    });
    const response = await client.send(command) as { Signature?: Uint8Array };

    if (!response.Signature) {
      throw new Error(`[ERR_KMS_NO_SIG] KMS returned no signature for ${keyId}`);
    }

    return new Uint8Array(response.Signature);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a KMS signer for a specific chain.
 *
 * Reads configuration from environment variables:
 * - KMS_KEY_ID_{CHAIN} or KMS_KEY_ID (fallback)
 * - AWS_REGION
 *
 * @param chainName - Chain to create signer for
 * @param provider - ethers provider for the chain
 * @param logger - Logger instance
 * @param kmsClient - Optional KMS client (defaults to AwsKmsClient)
 * @returns KmsSigner instance, or null if no KMS key is configured
 */
export function createKmsSigner(
  chainName: string,
  provider: ethers.Provider,
  logger: Logger,
  kmsClient?: KmsClient,
): KmsSigner | null {
  // Per-chain key takes precedence
  const keyId = process.env[`KMS_KEY_ID_${chainName.toUpperCase()}`]
    ?? process.env.KMS_KEY_ID;

  if (!keyId) {
    return null;
  }

  const client = kmsClient ?? new AwsKmsClient();

  return new KmsSigner({
    keyId,
    kmsClient: client,
    provider,
    logger,
    chainName,
  });
}
