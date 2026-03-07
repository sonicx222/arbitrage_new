# @arbitrage/security

Authentication, authorization, rate limiting, and input validation middleware for services.

## Key Exports

| Module | Purpose |
|--------|---------|
| `apiAuth()` | Unified auth middleware (API key first, then JWT) |
| `apiAuthorize(resource, action)` | Permission check middleware (supports wildcards) |
| `AuthService` | JWT + API key authentication |
| `RateLimiter` | Redis-backed rate limiting (**fails closed** when Redis unavailable) |
| `createApiRateLimiter()` | Pre-configured API rate limiter |
| `validateArbitrageRequest()` | Request validation with Joi schemas |
| `sanitizeInput()` | Input sanitization |

## Usage

```typescript
import { apiAuth, apiAuthorize } from '@arbitrage/security';

app.get('/api/metrics', apiAuth(), apiAuthorize('metrics', 'read'), handler);
```

## Auth Bypass (Development Only)

When neither `JWT_SECRET` nor `API_KEYS` is set **and** `NODE_ENV` is `test` or `development`, all requests are allowed with a default admin user. Production requires explicit auth configuration; `validateAuthEnvironment()` throws on startup if misconfigured.

## Dependencies

- `@arbitrage/core`
- `jsonwebtoken`, `bcrypt`, `joi`, `helmet`, `express-rate-limit`
