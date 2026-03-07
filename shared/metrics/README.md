# @arbitrage/metrics

Metrics collection and export infrastructure supporting Prometheus, JSON, OpenTelemetry, and Grafana dashboard generation.

## Build Order

**3rd** in build chain: types -> config -> flash-loan-aggregation / `metrics` -> core -> ml

## Architecture

```
Domain Layer     ── Metric definitions, aggregation logic
Application Layer ── Use case implementations
Infrastructure   ── Export backends (Prometheus, OTLP, JSON)
```

## Usage

Consumed by `@arbitrage/core/monitoring` for service-level metrics collection and `/metrics` endpoint exposure.

## Dependencies

None (only dev dependencies: `@types/node`, `typescript`).
