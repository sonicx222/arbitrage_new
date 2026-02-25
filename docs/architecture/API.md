# API Reference

> **Last Updated:** 2026-02-25
> **Version:** 2.0

This document provides the API reference for all service HTTP endpoints in the arbitrage system. All services use `createSimpleHealthServer` (from `@arbitrage/core/service-lifecycle`) or Express for their HTTP layer.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Coordinator Service](#coordinator-service)
4. [Partition Detectors (P1-P4)](#partition-detectors-p1-p4)
5. [Unified Detector](#unified-detector)
6. [Execution Engine](#execution-engine)
7. [Cross-Chain Detector](#cross-chain-detector)
8. [Mempool Detector](#mempool-detector)

---

## Overview

### Service Ports

| Service | Default Port | Env Override |
|---------|-------------|--------------|
| Coordinator | 3000 | `COORDINATOR_PORT` |
| Partition Asia-Fast (P1) | 3001 | `HEALTH_CHECK_PORT` |
| Partition L2-Turbo (P2) | 3002 | `HEALTH_CHECK_PORT` |
| Partition High-Value (P3) | 3003 | `HEALTH_CHECK_PORT` |
| Partition Solana (P4) | 3004 | `HEALTH_CHECK_PORT` |
| Execution Engine | 3005 | `HEALTH_CHECK_PORT` / `EXECUTION_ENGINE_PORT` |
| Cross-Chain Detector | 3006 | `HEALTH_CHECK_PORT` / `CROSS_CHAIN_DETECTOR_PORT` |
| Unified Detector | 3007 (default) | `HEALTH_CHECK_PORT` |
| Mempool Detector | 3008 | `healthCheckPort` config |

### No Standard Response Wrapper

Endpoints return plain JSON objects. There is no shared `{ status, data, error, timestamp }` response envelope. Each endpoint defines its own response shape as documented below.

---

## Authentication

Authentication is **implemented** via `shared/security/src/auth.ts`. Two methods are supported:

### API Key Authentication

Pass an API key in the `X-API-Key` header. Keys are configured via the `API_KEYS` environment variable:

```
API_KEYS=name1:key1:permissions,name2:key2:permissions
```

Keys are stored as SHA-256 hashes in memory. Each key maps to a name, role list, and permission list.

### JWT Authentication

Pass a JWT token in the `Authorization: Bearer <token>` header. Requires `JWT_SECRET` to be set. Tokens include userId, username, roles, and permissions claims. Token expiry defaults to 1 hour (`JWT_EXPIRES_IN`).

### Auth Bypass (Development Only)

If neither `JWT_SECRET` nor `API_KEYS` is set **and** `NODE_ENV` is `test` or `development`, all requests are allowed with a default admin user. In production or any other `NODE_ENV` value (including unset), requests are rejected with 503 if auth is not configured. See `validateAuthEnvironment()`.

### Middleware

- `apiAuth(options?)` -- Unified middleware that tries API key first, then JWT. Used on coordinator `/api/metrics`, `/api/services`, `/api/opportunities`, `/api/alerts`, `/api/leader`, `/api/redis/*`, and admin routes.
- `apiAuthorize(resource, action)` -- Permission check middleware. Checks `action:resource` against user permissions (supports wildcards like `read:*` or `*:*`).

---

## Coordinator Service

**Base URL:** `http://localhost:3000`

The coordinator uses Express with the following middleware stack (applied globally in `configureMiddleware`):

- **Helmet** -- Security headers (CSP, HSTS, X-Frame-Options, etc.)
- **CORS** -- Configurable via `ALLOWED_ORIGINS` env var (required in production)
- **JSON parsing** -- 1MB limit
- **Rate limiting** -- Configurable via `API_RATE_LIMIT_WINDOW_MS` (default: 15 min) and `API_RATE_LIMIT_MAX` (default: 100 requests per window)
- **Request logging** -- Logs method, URL, status, duration, client IP

### Route Groups

Routes are registered in `setupAllRoutes()`:
- `app.use('/', createDashboardRoutes(state))` -- Dashboard at root
- `app.use('/api', createHealthRoutes(state))` -- Health endpoints
- `app.use('/api', createMetricsRoutes(state))` -- Metrics/data endpoints
- `app.use('/api', createAdminRoutes(state))` -- Admin actions

### Dashboard

```
GET /
```

Returns an HTML dashboard with system status, service health, trading metrics, and profit data. Auto-refreshes every 10 seconds. Response is cached for 1 second.

**Auth:** If `DASHBOARD_AUTH_TOKEN` is set, requires `Authorization: Bearer <token>`. Required in production (startup throws without it).

### Health Routes (Public)

#### GET /api/health

System health status. Uses `validateHealthRequest` for query validation but does **not** require authentication.

**Unauthenticated response:**

```json
{
  "status": "healthy",
  "systemHealth": 95.5,
  "timestamp": 1740000000000
}
```

**Authenticated response** (when `req.user` is set by auth middleware):

```json
{
  "status": "healthy",
  "isLeader": true,
  "instanceId": "coordinator-us-east1-abc-1740000000000",
  "systemHealth": 95.5,
  "services": {
    "partition-asia-fast": { "status": "healthy", "..." : "..." },
    "execution-engine": { "status": "healthy", "..." : "..." }
  },
  "timestamp": 1740000000000
}
```

`status` is `"healthy"` when `systemHealth >= 50`, `"degraded"` otherwise.

#### GET /api/health/live

Liveness probe. Always returns 200 if the process is running.

```json
{ "status": "alive", "timestamp": 1740000000000 }
```

#### GET /api/health/ready

Readiness probe. Returns 200 when running and `systemHealth > 0`, otherwise 503.

```json
{
  "status": "ready",
  "isRunning": true,
  "systemHealth": 95.5,
  "timestamp": 1740000000000
}
```

### Metrics Routes (Authenticated)

All metrics routes require authentication (`apiAuth()`) and read authorization.

#### GET /api/metrics

**Auth:** Required. Permission: `read:metrics`.

Returns system-wide metrics object from `state.getSystemMetrics()`.

#### GET /api/services

**Auth:** Required. Permission: `read:services`.

Returns health status map for all services.

#### GET /api/opportunities

**Auth:** Required. Permission: `read:opportunities`.

Returns the 100 most recent arbitrage opportunities, sorted by timestamp descending. Uses heap-based partial sort for performance on large sets.

#### GET /api/alerts

**Auth:** Required. Permission: `read:alerts`.

Returns up to 100 recent alerts from alert history.

#### GET /api/leader

**Auth:** Required. Permission: `read:leader`.

```json
{
  "isLeader": true,
  "instanceId": "coordinator-us-east1-abc-1740000000000",
  "lockKey": "leader:coordinator"
}
```

#### GET /api/redis/stats

**Auth:** Required. Permission: `read:metrics`.

Returns Redis command usage statistics. Has a 5-second timeout for Redis connection. Returns 504 on timeout, 500 on other errors.

#### GET /api/redis/dashboard

**Auth:** Required. Permission: `read:metrics`.

Returns a text/plain formatted Redis usage dashboard. Has a 5-second timeout. Returns 504 on timeout, 500 on other errors.

#### GET /api/metrics/prometheus

**Auth:** Required. Permission: `read:metrics`.

Returns stream health metrics in Prometheus text exposition format (`text/plain; version=0.0.4`). Exposes `stream_length`, `stream_pending`, `stream_consumer_groups`, and `stream_health_status` gauges.

### Admin Routes (Authenticated, Rate-Limited)

Admin routes have a strict rate limiter: **5 requests per 15-minute window**.

All admin routes require authentication (`apiAuth()`) and write authorization.

#### POST /api/services/:service/restart

**Auth:** Required. Permission: `write:services`. Leader-only.

Requests a service restart. The `:service` parameter must match one of the allowed service names (validated against `ALLOWED_SERVICES` list which includes all partition, coordinator, execution, analysis, and legacy service names).

**Validation:**
- Service name must match `^[a-zA-Z0-9_-]+$`
- Service must be in the allowed services list (returns 404 if not)
- Coordinator must be the leader (returns 403 if not)

**Response:**

```json
{ "success": true, "message": "Restart requested for partition-asia-fast" }
```

#### POST /api/alerts/:alert/acknowledge

**Auth:** Required. Permission: `write:alerts`.

Acknowledges an alert, clearing its cooldown. Tries exact match first, then tries with `_system` suffix.

**Response:**

```json
{ "success": true, "message": "Alert acknowledged" }
```

---

## Partition Detectors (P1-P4)

**Base URLs:** `http://localhost:3001` through `http://localhost:3004`

Partition detectors use `createPartitionHealthServer()` from `shared/core/src/partition/health-server.ts`. All endpoints are GET-only (405 for other methods).

**Security:**
- When `HEALTH_AUTH_TOKEN` is set, `/stats` requires `Authorization: Bearer <token>` (returns 401 without it)
- In production, binding to `0.0.0.0` without `HEALTH_AUTH_TOKEN` causes startup failure
- Server timeouts: `requestTimeout=5000`, `headersTimeout=3000`, `keepAliveTimeout=5000`, `maxConnections=100`

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info |
| `GET /health` | Health status (liveness probe) |
| `GET /ready` | Readiness check (readiness probe) |
| `GET /stats` | Detailed statistics (auth-gated) |

#### GET /

```json
{
  "service": "partition-asia-fast",
  "description": "asia-fast Partition Detector",
  "partitionId": "asia-fast",
  "chains": ["bsc", "polygon", "avalanche", "fantom"],
  "region": "asia-southeast1",
  "endpoints": ["/health", "/ready", "/stats"]
}
```

#### GET /health

Health data is cached for 1 second. Returns 200 for `healthy`/`degraded`, 503 otherwise.

```json
{
  "service": "partition-asia-fast",
  "status": "healthy",
  "partitionId": "asia-fast",
  "chains": ["bsc", "polygon", "avalanche", "fantom"],
  "healthyChains": ["bsc", "polygon", "avalanche", "fantom"],
  "uptime": 3600,
  "eventsProcessed": 12345,
  "memoryMB": 128,
  "region": "asia-southeast1",
  "timestamp": 1740000000000
}
```

#### GET /ready

Returns 200 when detector is running, 503 otherwise.

```json
{
  "service": "partition-asia-fast",
  "ready": true,
  "chains": ["bsc", "polygon", "avalanche", "fantom"]
}
```

#### GET /stats

**Auth:** Requires `Authorization: Bearer <HEALTH_AUTH_TOKEN>` when token is configured.

```json
{
  "service": "partition-asia-fast",
  "partitionId": "asia-fast",
  "chains": ["bsc", "polygon", "avalanche", "fantom"],
  "totalEvents": 12345,
  "totalOpportunities": 42,
  "uptimeSeconds": 3600,
  "memoryMB": 128,
  "chainStats": {
    "bsc": { "..." : "..." },
    "polygon": { "..." : "..." }
  }
}
```

---

## Unified Detector

**Base URL:** `http://localhost:3007` (default, configurable)

The unified detector is a library/factory used by P1-P3 partitions (not a standalone service by default). When run directly, it uses `createSimpleHealthServer`.

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info with endpoints list |
| `GET /health` | Health status (cached 1s) |
| `GET /ready` | Readiness check |
| `GET /stats` | Partition statistics |

#### GET /health

```json
{
  "service": "unified-detector-asia-fast",
  "status": "healthy",
  "partitionId": "asia-fast",
  "chains": ["bsc", "polygon", "avalanche", "fantom"],
  "healthyChains": ["bsc", "polygon"],
  "uptime": 3600,
  "eventsProcessed": 12345,
  "memoryMB": 128,
  "region": "asia-southeast1",
  "timestamp": 1740000000000
}
```

#### GET /stats

```json
{
  "service": "unified-detector-asia-fast",
  "partitionId": "asia-fast",
  "chains": ["bsc", "polygon", "avalanche", "fantom"],
  "totalEvents": 12345,
  "totalOpportunities": 42,
  "uptimeSeconds": 3600,
  "memoryMB": 128,
  "chainStats": { "bsc": {}, "polygon": {} }
}
```

---

## Execution Engine

**Base URL:** `http://localhost:3005`

Uses `createSimpleHealthServer` with additional routes for metrics, stats, bridge recovery, probability tracking, and circuit breaker control.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | None | Service info with endpoints list |
| `/health` | GET | None | Health status with execution metrics |
| `/ready` | GET | None | Readiness check |
| `/metrics` | GET | None | Prometheus text metrics |
| `/stats` | GET | None | Execution statistics with consumer lag |
| `/bridge-recovery` | GET | None | Bridge recovery status and metrics |
| `/probability-tracker` | GET | None | Probability tracker statistics |
| `/circuit-breaker` | GET | None | Circuit breaker status |
| `/circuit-breaker/close` | POST | API Key | Force close circuit breaker |
| `/circuit-breaker/open` | POST | API Key | Force open circuit breaker |

#### GET /health

Returns 200 for `healthy`/`degraded`, 503 for `unhealthy`.

```json
{
  "service": "execution-engine",
  "status": "healthy",
  "simulationMode": false,
  "redisConnected": true,
  "healthyProviders": 3,
  "queueSize": 0,
  "activeExecutions": 0,
  "executionAttempts": 45,
  "successRate": "84.44%",
  "dlqLength": 0,
  "dlqAlert": false,
  "consumerLagPending": 2,
  "consumerLagAlert": false,
  "uptime": 3600.5,
  "memoryMB": 256,
  "timestamp": 1740000000000
}
```

#### GET /ready

Returns 200 when: engine is running, Redis is healthy, and providers are available (or simulation mode is on). Returns 503 otherwise.

```json
{ "service": "execution-engine", "ready": true }
```

#### GET /metrics

Returns Prometheus text exposition format (`text/plain; version=0.0.4`).

#### GET /stats

```json
{
  "service": "execution-engine",
  "stats": {
    "executionAttempts": 45,
    "successfulExecutions": 38,
    "failedExecutions": 7,
    "..."  : "..."
  },
  "consumerLag": {
    "pendingCount": 2,
    "minId": "1740000000000-0",
    "maxId": "1740000000001-0"
  }
}
```

#### GET /bridge-recovery

```json
{
  "service": "execution-engine",
  "bridgeRecovery": {
    "isRunning": true,
    "metrics": { "..." : "..." }
  }
}
```

#### GET /probability-tracker

```json
{
  "service": "execution-engine",
  "probabilityTracker": { "..." : "..." }
}
```

#### GET /circuit-breaker

Public read. Returns current circuit breaker status.

```json
{
  "state": "CLOSED",
  "consecutiveFailures": 0,
  "lastFailureTime": null,
  "lastSuccessTime": 1740000000000,
  "totalFailures": 3,
  "totalSuccesses": 42,
  "timestamp": 1740000000000
}
```

Returns 503 if circuit breaker is not available.

#### POST /circuit-breaker/close

**Auth:** Requires `CIRCUIT_BREAKER_API_KEY` via `X-API-Key` header or `Authorization: Bearer <key>`. Uses timing-safe comparison.

Force closes the circuit breaker.

**Response (200):**

```json
{
  "success": true,
  "message": "Circuit breaker force closed",
  "status": { "state": "CLOSED", "..." : "..." },
  "timestamp": 1740000000000
}
```

**Error (401):**

```json
{ "error": "API key required", "timestamp": 1740000000000 }
```

#### POST /circuit-breaker/open

**Auth:** Same as `/circuit-breaker/close`.

Force opens the circuit breaker. Accepts optional JSON body with `reason` field.

**Request body (optional):**

```json
{ "reason": "Manual maintenance window" }
```

**Response (200):**

```json
{
  "success": true,
  "message": "Circuit breaker force opened: Manual maintenance window",
  "status": { "state": "OPEN", "..." : "..." },
  "timestamp": 1740000000000
}
```

---

## Cross-Chain Detector

**Base URL:** `http://localhost:3006`

Uses `createSimpleHealthServer` with default endpoints only.

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info with endpoints list |
| `GET /health` | Health status |
| `GET /ready` | Readiness check |

#### GET /health

```json
{
  "service": "cross-chain-detector",
  "status": "healthy",
  "uptime": 3600.5,
  "memoryMB": 64,
  "timestamp": 1740000000000
}
```

#### GET /ready

```json
{ "service": "cross-chain-detector", "ready": true }
```

---

## Mempool Detector

**Base URL:** `http://localhost:3008`

> **Note:** Optional service (`npm run dev:mempool`). Requires bloXroute BDN access.

Uses `createSimpleHealthServer` with additional `/stats` route.

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info with endpoints list |
| `GET /health` | Health status with feed and buffer metrics |
| `GET /ready` | Readiness check (running + feeds connected) |
| `GET /stats` | Detailed internal statistics |

#### GET /health

Returns 200 for `healthy`/`degraded`, 503 for `unhealthy`.

```json
{
  "service": "mempool-detector",
  "instanceId": "mempool-detector-1740000000000",
  "status": "healthy",
  "feeds": {
    "ethereum": {
      "connectionState": "connected",
      "..." : "..."
    },
    "bsc": {
      "connectionState": "connected",
      "..." : "..."
    }
  },
  "bufferSize": 42,
  "stats": {
    "txReceived": 12345,
    "txDecoded": 1234,
    "opportunitiesPublished": 567,
    "latencyP50": 0.15,
    "latencyP99": 1.23
  },
  "uptime": 86400000,
  "timestamp": 1740000000000
}
```

#### GET /ready

Returns 200 when service is running and at least one feed is connected, 503 otherwise.

```json
{ "service": "mempool-detector", "ready": true }
```

#### GET /stats

```json
{
  "instanceId": "mempool-detector-1740000000000",
  "stats": {
    "txReceived": 12345,
    "txDecoded": 1234,
    "txDecodeFailures": 5,
    "opportunitiesPublished": 567,
    "bufferOverflows": 0
  },
  "bufferStats": { "size": 42, "capacity": 10000 },
  "latencyBufferStats": { "size": 1000, "capacity": 1000 },
  "batcherStats": { "..." : "..." }
}
```

---

## Related Documentation

- [Architecture Overview](ARCHITECTURE_V2.md)
- [Current State](CURRENT_STATE.md)
- [Configuration Reference](../CONFIGURATION.md)
- [Local Development](../local-development.md)
