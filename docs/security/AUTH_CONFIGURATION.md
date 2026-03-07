# Authentication & Authorization Configuration

> **Last Updated:** 2026-03-07
> **Related:** [SECRETS_MANAGEMENT.md](SECRETS_MANAGEMENT.md), [API Reference](../architecture/API.md)

The system supports API Key and JWT authentication with role-based authorization. Authentication is mandatory in production.

---

## Quick Start

### Development (no auth required)

When `NODE_ENV=development` or `test`, auth is bypassed. All requests receive a default admin user with `*:*` permissions.

### Production Setup

Set at least one of:

```bash
# Option 1: API Keys (simplest)
API_KEYS=admin:your-secret-key:*;*,monitor:read-only-key:read;*

# Option 2: JWT
JWT_SECRET=generate-a-secure-random-string-minimum-32-chars

# Option 3: Both (recommended)
API_KEYS=coordinator:service-key:read;*;write;services
JWT_SECRET=your-jwt-secret
```

---

## API Key Authentication

### Format

```
API_KEYS=name1:key1:perm1;perm2,name2:key2:perm1;perm2
```

| Field | Description | Example |
|-------|-------------|---------|
| `name` | Key identifier (logged, not secret) | `coordinator` |
| `key` | Secret key value | `abc123xyz` |
| `perms` | Semicolon-separated permissions | `read;*;write;services` |

**Important:** Keys must NOT contain `:` characters (used as delimiter). Use hex encoding, not base64.

### How Keys Are Stored

Keys are hashed with SHA-256 on startup. Plaintext keys are never stored in memory.

```
Client sends: X-API-Key: abc123xyz
Server computes: SHA256("abc123xyz") → "a1b2c3..."
Server looks up: apiKeyStore.get("a1b2c3...")
```

### Usage

Pass the key in the `X-API-Key` header:

```bash
curl -H "X-API-Key: your-secret-key" http://localhost:3000/api/metrics
```

---

## JWT Authentication

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Signing secret (required for JWT auth) | -- |
| `JWT_EXPIRES_IN` | Token expiry duration | `1h` |
| `BCRYPT_ROUNDS` | Password hashing rounds (min 12 in production) | `12` |

### Token Structure

```json
{
  "userId": "user-123",
  "username": "trader",
  "roles": ["trader"],
  "permissions": ["read:*", "write:orders", "execute:arbitrage"],
  "iat": 1740000000,
  "exp": 1740003600
}
```

### Usage

Pass the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." http://localhost:3000/api/metrics
```

### Token Blacklisting

Logged-out tokens are blacklisted in Redis (`auth:blacklist:{token}`) with TTL matching the token's remaining lifetime.

---

## Permission Model

Permissions follow the `action:resource` pattern with wildcard support.

### Permission Format

| Permission | Meaning |
|------------|---------|
| `read:metrics` | Read metrics |
| `write:services` | Write to services (restart, etc.) |
| `execute:arbitrage` | Execute trades |
| `read:*` | Read any resource |
| `*:opportunities` | Any action on opportunities |
| `*:*` | Full admin access |

### Built-in Roles

| Role | Permissions |
|------|------------|
| `admin` | `*:*` (everything) |
| `trader` | `read:*`, `write:orders`, `execute:arbitrage` |
| `viewer` | `read:*` |
| `user` | `read:opportunities`, `read:health`, `read:metrics` |
| `api-service` | `read:*` |

### Authorization Flow

1. Extract user from request (`apiAuth()` middleware)
2. Check `action:resource` against user's direct permissions
3. Check wildcard matches (`read:*` matches `read:metrics`)
4. For JWT users: also check role-based permissions
5. Deny with 403 if no match

---

## Middleware Usage

### `apiAuth(options?)`

Unified authentication middleware. Tries API key first, then JWT.

```typescript
// Require authentication (default)
app.get('/api/metrics', apiAuth(), handler);

// Optional authentication
app.get('/public', apiAuth({ required: false }), handler);
```

### `apiAuthorize(resource, action)`

Permission check middleware. Must follow `apiAuth()`.

```typescript
app.post('/api/services/:id/restart',
  apiAuth(),
  apiAuthorize('services', 'write'),
  handler
);
```

---

## Rate Limiting & Lockout

### Account Lockout

| Setting | Value |
|---------|-------|
| Max login attempts | 5 per 15-minute window |
| Lockout duration | 15 minutes |
| Storage | Redis keys: `auth:attempts:{username}`, `auth:lockout:{username}` |

### Rate Limiter Fail Mode

The rate limiter **fails closed** by default. When Redis is unavailable, requests are denied (not allowed). This prevents an attacker from crashing Redis to bypass rate limits.

---

## Environment Validation

`validateAuthEnvironment()` runs at service startup:

| Condition | Result |
|-----------|--------|
| `JWT_SECRET` or `API_KEYS` set | Auth enabled, no error |
| Neither set + `NODE_ENV=development` or `test` | Warning logged, bypass allowed |
| Neither set + `NODE_ENV=production` or unset | **Throws error** (service won't start) |

Call this function early in service initialization to fail fast on misconfiguration.

---

## Response Codes

| Status | When |
|--------|------|
| `200` | Authentication and authorization successful |
| `401` | Missing or invalid credentials |
| `403` | Valid credentials but insufficient permissions |
| `429` | Rate limit exceeded (includes `Retry-After` header) |
| `503` | Auth not configured in production |

---

## Troubleshooting

**401 on all requests in production:**
1. Verify `API_KEYS` or `JWT_SECRET` is set in environment
2. Check key format: `name:key:perm1;perm2` (no spaces)
3. Ensure key doesn't contain `:` characters

**403 despite valid credentials:**
1. Check user permissions match required `action:resource`
2. Verify wildcard permissions: `read:*` matches `read:metrics` but NOT `write:metrics`
3. For JWT: check token hasn't expired (`exp` claim)

**503 "Authentication not configured":**
1. This only happens when `NODE_ENV` is NOT `test` or `development`
2. Set `API_KEYS` or `JWT_SECRET` in `.env.local`
3. Or set `NODE_ENV=development` for local dev

**Account locked out:**
1. Wait 15 minutes for automatic unlock
2. Or manually delete: `redis-cli DEL auth:lockout:{username} auth:attempts:{username}`

---

## Key Files

| File | Purpose |
|------|---------|
| `shared/security/src/auth.ts` | Core auth implementation (893 lines) |
| `shared/security/src/rate-limiter.ts` | Rate limiting (396 lines) |
| `shared/security/src/validation.ts` | Input validation (310 lines) |
| `shared/security/__tests__/unit/auth.test.ts` | Unit tests |
| `shared/security/__tests__/unit/api-key-auth.test.ts` | API key tests |
| `shared/security/__tests__/integration/security-flow.integration.test.ts` | Integration tests |
