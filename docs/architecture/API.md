# API Reference

> **Last Updated:** 2026-02-05
> **Version:** 1.0

This document provides the API reference for all service endpoints in the arbitrage system.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Coordinator Service](#coordinator-service)
4. [Partition Detectors](#partition-detectors)
5. [Execution Engine](#execution-engine)
6. [Cross-Chain Detector](#cross-chain-detector)
7. [Error Codes](#error-codes)

---

## Overview

### Base URLs

| Service | Port | Base URL |
|---------|------|----------|
| Coordinator | 3000 | `http://localhost:3000/api` |
| Partition Asia-Fast | 3001 | `http://localhost:3001` |
| Partition L2-Turbo | 3002 | `http://localhost:3002` |
| Partition High-Value | 3003 | `http://localhost:3003` |
| Partition Solana | 3004 | `http://localhost:3004` |
| Execution Engine | 3005 | `http://localhost:3005` |
| Cross-Chain Detector | 3006 | `http://localhost:3006` |
| Unified Detector | 3007 | `http://localhost:3007` |
| Mempool Detector | 3008 | `http://localhost:3008` |

### Response Format

All endpoints return JSON with this structure:

```json
{
  "status": "success" | "error",
  "data": { ... },
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  },
  "timestamp": "2026-02-05T12:00:00.000Z"
}
```

---

## Authentication

Currently, the system runs in a trusted network environment. Future versions will implement:

- **API Keys**: For service-to-service communication
- **JWT Tokens**: For dashboard access
- **Rate Limiting**: Per-client request limits

---

## Coordinator Service

Base URL: `http://localhost:3000/api`

### Health Check

```
GET /health
```

Returns system-wide health status.

**Response:**

```json
{
  "status": "healthy",
  "services": {
    "coordinator": "healthy",
    "partition-asia-fast": "healthy",
    "partition-l2-turbo": "healthy",
    "partition-high-value": "healthy",
    "partition-solana": "healthy",
    "execution-engine": "healthy",
    "cross-chain-detector": "healthy",
    "unified-detector": "healthy",
    "mempool-detector": "healthy"
  },
  "leader": true,
  "uptime": 86400,
  "version": "2.8.0"
}
```

### System Status

```
GET /status
```

Returns detailed system metrics.

**Response:**

```json
{
  "status": "success",
  "data": {
    "opportunities": {
      "detected": 523,
      "executed": 45,
      "profitable": 38
    },
    "latency": {
      "detection": 42,
      "execution": 156
    },
    "chains": {
      "active": 11,
      "synced": 11
    }
  }
}
```

### Service Control

```
POST /services/:serviceId/restart
```

Restart a specific service.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| serviceId | string | Service identifier (e.g., `partition-asia-fast`) |

**Response:**

```json
{
  "status": "success",
  "data": {
    "serviceId": "partition-asia-fast",
    "action": "restart",
    "previousState": "healthy",
    "newState": "starting"
  }
}
```

---

## Partition Detectors

Base URL: `http://localhost:300{1-4}`

### Health Check

```
GET /health
```

Returns partition-specific health.

**Response:**

```json
{
  "status": "healthy",
  "partition": "asia-fast",
  "chains": ["bsc", "polygon", "avalanche", "fantom"],
  "blocksProcessed": {
    "bsc": 12345678,
    "polygon": 23456789
  },
  "opportunities": {
    "detected": 127,
    "published": 125
  },
  "lastUpdate": "2026-02-05T12:00:00.000Z"
}
```

### Metrics

```
GET /metrics
```

Returns Prometheus-formatted metrics.

**Response:**

```
# HELP arbitrage_opportunities_total Total opportunities detected
# TYPE arbitrage_opportunities_total counter
arbitrage_opportunities_total{partition="asia-fast",chain="bsc"} 523

# HELP arbitrage_detection_latency_ms Detection latency in milliseconds
# TYPE arbitrage_detection_latency_ms histogram
arbitrage_detection_latency_ms_bucket{le="10"} 100
arbitrage_detection_latency_ms_bucket{le="50"} 450
arbitrage_detection_latency_ms_bucket{le="100"} 500
```

---

## Execution Engine

Base URL: `http://localhost:3005`

### Health Check

```
GET /health
```

**Response:**

```json
{
  "status": "healthy",
  "trades": {
    "pending": 2,
    "completed": 45,
    "failed": 3
  },
  "circuitBreaker": {
    "state": "CLOSED",
    "failures": 0
  },
  "wallets": {
    "eth": "0x...",
    "bsc": "0x...",
    "solana": "..."
  }
}
```

### Execute Trade

```
POST /execute
```

Execute an arbitrage opportunity.

**Request Body:**

```json
{
  "opportunityId": "opp_12345",
  "chain": "bsc",
  "path": [
    {
      "dex": "pancakeswap",
      "tokenIn": "0x...",
      "tokenOut": "0x...",
      "amountIn": "1000000000000000000"
    }
  ],
  "minProfit": "50000000000000000",
  "deadline": 1707134400,
  "useFlashLoan": true
}
```

**Response:**

```json
{
  "status": "success",
  "data": {
    "transactionHash": "0x...",
    "gasUsed": 250000,
    "profit": "75000000000000000",
    "executionTime": 156
  }
}
```

### Circuit Breaker Control

```
POST /circuit-breaker/:action
```

Control the execution circuit breaker.

**Parameters:**

| Name | Type | Values |
|------|------|--------|
| action | string | `open`, `close`, `half-open` |

---

## Cross-Chain Detector

Base URL: `http://localhost:3006`

### Health Check

```
GET /health
```

**Response:**

```json
{
  "status": "healthy",
  "bridges": {
    "active": 5,
    "monitoring": ["eth-arbitrum", "eth-optimism", "eth-base", "bsc-polygon"]
  },
  "opportunities": {
    "detected": 23,
    "viable": 8
  }
}
```

### Bridge Status

```
GET /bridges
```

Returns status of monitored bridges.

**Response:**

```json
{
  "status": "success",
  "data": [
    {
      "bridge": "eth-arbitrum",
      "latency": 180,
      "fee": "0.001",
      "available": true
    }
  ]
}
```

---

## Mempool Detector

Base URL: `http://localhost:3008`

> **Note:** The mempool detector is an optional service (`npm run dev:mempool`). It requires bloXroute BDN access.

### Health Check

```
GET /health
```

**Response:**

```json
{
  "status": "healthy",
  "service": "mempool-detector",
  "connections": {
    "bloxroute": "connected",
    "redis": "connected"
  },
  "stats": {
    "pendingTxProcessed": 12345,
    "opportunitiesDetected": 42,
    "latencyMs": 3
  }
}
```

### Readiness

```
GET /ready
```

Returns 200 when the service is connected to bloXroute BDN and Redis, 503 otherwise.

### Statistics

```
GET /stats
```

Returns detailed mempool monitoring statistics including decode rates, buffer utilization, and publishing metrics.

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_REQUEST` | 400 | Malformed request body |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `NOT_FOUND` | 404 | Resource not found |
| `CIRCUIT_OPEN` | 503 | Circuit breaker is open |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `CHAIN_UNAVAILABLE` | 503 | Blockchain RPC unavailable |
| `INSUFFICIENT_FUNDS` | 400 | Wallet balance too low |
| `SLIPPAGE_EXCEEDED` | 400 | Slippage higher than threshold |
| `OPPORTUNITY_EXPIRED` | 400 | Opportunity no longer profitable |

---

## WebSocket Endpoints

### Real-time Opportunities

```
ws://localhost:3000/ws/opportunities
```

Subscribe to real-time opportunity notifications.

**Message Format:**

```json
{
  "type": "opportunity",
  "data": {
    "id": "opp_12345",
    "chain": "bsc",
    "type": "triangular",
    "profit": "0.05",
    "confidence": 0.85,
    "expiry": 5000
  }
}
```

### System Events

```
ws://localhost:3000/ws/events
```

Subscribe to system events (health changes, circuit breaker, etc.).

---

## Rate Limits

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| Health checks | 60 | 1 minute |
| Read operations | 100 | 1 minute |
| Write operations | 20 | 1 minute |
| WebSocket messages | 1000 | 1 minute |

---

## Related Documentation

- [Architecture Overview](architecture/ARCHITECTURE_V2.md)
- [Current State](architecture/CURRENT_STATE.md)
- [Local Development](local-development.md)
