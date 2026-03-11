# Redis Stream HMAC Signing

> **Last Updated:** 2026-03-07
> **Related:** [ADR-002: Redis Streams](../architecture/adr/ADR-002-redis-streams.md), [SECRETS_MANAGEMENT.md](SECRETS_MANAGEMENT.md)

All Redis Streams messages can be signed with HMAC-SHA256 to prevent tampering. When enabled, messages are signed on write and verified on read. Invalid or unsigned messages are rejected.

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `STREAM_SIGNING_KEY` | Current HMAC signing key (any UTF-8 string, 32+ bytes recommended) | unset (disabled) |
| `STREAM_SIGNING_KEY_PREVIOUS` | Previous key for zero-downtime rotation (OP-17) | unset |

**Production requirement:** If `NODE_ENV=production` and `STREAM_SIGNING_KEY` is not set, the service throws on startup. Signing is mandatory in production.

**Key files:** `shared/core/src/redis/streams.ts` (signing/verification), `shared/core/src/utils/hmac-utils.ts` (utility functions)

---

## How It Works

### Sign on Write (xadd)

When publishing via `xadd()`, if `signingKey` is configured:

1. Message is serialized to JSON (with BigInt support)
2. HMAC-SHA256 computed: `HMAC(key, "streamName:serializedData")`
3. Two fields stored in Redis: `data` (serialized) and `sig` (hex signature)

### Verify on Read (xread/xreadgroup)

When consuming messages:

1. Extract raw `data` and `sig` fields
2. Call `verifySignature(data, sig, streamName)` using `crypto.timingSafeEqual`
3. If verification fails: message rejected, logged as WARN, skipped
4. If valid: `sig` field stripped from parsed output (not leaked to application)

### Cross-Stream Replay Protection (OP-18)

The stream name is included in the HMAC input:

```
HMAC input = "stream:opportunities:{"chain":"bsc",...}"
```

This means a message signed for `stream:opportunities` produces a different signature than the same payload signed for `stream:execution-requests`. An attacker cannot replay messages across streams.

---

## Zero-Downtime Key Rotation (OP-17)

### Step 1: Deploy new key to all services

Set both keys on every service instance:

```bash
STREAM_SIGNING_KEY=<new_key>
STREAM_SIGNING_KEY_PREVIOUS=<old_key>
```

Restart all services. During this window:
- New messages are signed with the new key
- Old messages (still in streams) are verified against both keys
- `verifySignature()` tries current key first, then previous key

### Step 2: Wait for old messages to drain

Old messages signed with the previous key will be consumed within minutes (depends on stream retention and consumer lag). Monitor consumer lag to confirm all old messages are processed.

### Step 3: Remove previous key

```bash
STREAM_SIGNING_KEY=<new_key>
# Remove STREAM_SIGNING_KEY_PREVIOUS
```

Restart all services. Only the new key is used for both signing and verification.

### Why This Is Safe

- During Step 1, both keys are accepted (no message rejection)
- Step 2 ensures no in-flight messages use the old key
- Step 3 reduces verification to 1 HMAC operation per message (optimal)

---

## Error Handling

| Condition | Action | Log Level |
|-----------|--------|-----------|
| Signing disabled (no key) | All messages pass through | -- |
| Valid signature | Accept message | -- |
| Invalid signature | Reject, skip message | WARN |
| Unsigned message (signing enabled) | Reject, skip message | WARN |
| Malformed (sig present, no data) | Reject, skip message | WARN |
| Empty/whitespace signing key | Signing disabled + warning | WARN |

In consumer groups, rejected messages are auto-ACKed to prevent PEL (pending entry list) growth.

---

## Performance

- **KeyObject caching (OP-32):** `crypto.createSecretKey()` called once at startup, not per-message
- **Max HMAC ops per message:**
  - 1 op: current key only (normal operation)
  - 2 ops: during key rotation OR legacy compat
  - 4 ops: legacy compat + key rotation (worst case, temporary)
- **Timing-safe comparison:** `crypto.timingSafeEqual` prevents timing attacks on signature verification

---

## Legacy Compatibility

**Removed in OPT-005.** The `STREAM_LEGACY_HMAC_COMPAT` and `LEGACY_HMAC_COMPAT` env vars
are no longer recognized. All producers now include stream name in HMAC signatures (OP-18 format).
Legacy (pre-OP-18) messages without stream name in the signature will fail verification.

---

## Troubleshooting

**Messages rejected with "Invalid message signature":**
1. Check all services use the same `STREAM_SIGNING_KEY`
2. During rotation, verify `STREAM_SIGNING_KEY_PREVIOUS` is set on consumers

**Messages rejected with "Unsigned message received":**
1. Producer is not signing (missing `STREAM_SIGNING_KEY`)
2. Fix: Set `STREAM_SIGNING_KEY` on all producers and restart

**Startup error "STREAM_SIGNING_KEY is required in production":**
1. Set `STREAM_SIGNING_KEY` in `.env.local` or deployment config
2. This is mandatory when `NODE_ENV=production`

---

## Test Coverage

- **Unit:** `shared/core/__tests__/unit/redis-streams/redis-streams-signing.test.ts` (517 lines)
- **Integration:** `shared/core/__tests__/integration/redis-streams-hmac-e2e.integration.test.ts` (607 lines)
- **HMAC utils:** `shared/core/__tests__/unit/utils/hmac-utils.test.ts` (399 lines)
