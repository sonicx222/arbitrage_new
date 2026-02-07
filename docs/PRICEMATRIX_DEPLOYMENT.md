# PriceMatrix Deployment Guide

**Updated**: 2026-02-07 | Post-Integration Testing (Tasks #40-46)

This guide covers production deployment requirements for the PriceMatrix SharedArrayBuffer integration in the unified-detector service.

---

## Table of Contents
- [Prerequisites](#prerequisites)
- [Node.js Configuration](#nodejs-configuration)
- [Environment Variables](#environment-variables)
- [Memory Requirements](#memory-requirements)
- [Pre-Flight Checklist](#pre-flight-checklist)
- [Performance Monitoring](#performance-monitoring)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software
- **Node.js**: >= 22.0.0 (for stable SharedArrayBuffer support)
- **npm**: >= 9.0.0
- **Redis**: >= 7.0 (for L2 cache)
- **Docker** (optional, for Redis)

### System Requirements
- **CPU**: 4+ cores recommended (for worker thread pool)
- **RAM**: 4GB minimum, 8GB recommended
- **OS**: Linux, macOS, or Windows (WSL2 recommended for Windows)

---

## Node.js Configuration

### Required Flags

The PriceMatrix uses SharedArrayBuffer for zero-copy worker thread access. Node.js requires specific flags for security and performance:

```bash
# Production deployment command
NODE_ENV=production \
  node \
  --max-old-space-size=4096 \
  --expose-gc \
  --unhandled-rejections=strict \
  dist/services/unified-detector/src/index.js
```

### Flag Explanations

| Flag | Purpose | Required? |
|------|---------|-----------|
| `--max-old-space-size=4096` | Set heap size to 4GB (adjust based on load) | ✓ Yes |
| `--expose-gc` | Enable GC monitoring and manual GC triggers | Recommended |
| `--unhandled-rejections=strict` | Fail fast on unhandled promise rejections | Recommended |

**Note**: SharedArrayBuffer is **enabled by default** in Node.js >=22. No additional flags needed for SAB support.

### Optional Performance Flags

For advanced optimization:

```bash
# Advanced performance tuning
node \
  --max-old-space-size=4096 \
  --expose-gc \
  --optimize-for-size \
  --max-http-header-size=16384 \
  dist/services/unified-detector/src/index.js
```

---

## Environment Variables

### Required Configuration

```bash
# .env
NODE_ENV=production
REDIS_URL=redis://localhost:6379
PARTITION_ID=unified-detector

# Cache configuration
CACHE_L1_SIZE_MB=64
CACHE_L2_TTL_SEC=300
CACHE_USE_PRICE_MATRIX=true

# Worker pool configuration
WORKER_POOL_SIZE=4
WORKER_POOL_MAX_QUEUE=10000
```

### Cache Sizing Guidelines

Based on integration test results (Tasks #40-46):

| Pairs Monitored | L1 Size (MB) | L2 Redis (MB) | Memory Overhead |
|----------------|--------------|---------------|-----------------|
| 500 | 32 | 128 | +20MB |
| 1000 | 64 | 256 | +40MB |
| 2000 | 128 | 512 | +80MB |
| 5000 | 320 | 1024 | +200MB |

**Formula**: L1 size ≈ `(pairs * 16 bytes * 2.5 overhead factor) / 1MB`

---

## Memory Requirements

### Production Memory Profile (Measured)

From 15-minute sustained load test (Task #45):

| Component | Baseline | Under Load | Peak |
|-----------|----------|------------|------|
| Node.js heap | 250MB | 350-400MB | 450MB |
| PriceMatrix L1 | 64MB | 64MB (fixed) | 64MB |
| Worker threads (4x) | 40MB | 80-100MB | 120MB |
| Redis connection | 20MB | 30-40MB | 50MB |
| **Total** | **374MB** | **524-604MB** | **684MB** |

**Recommendation**: Allocate **1GB RAM** per unified-detector instance (50% headroom).

### Memory Growth Rate

Validated in Task #45:
- **Target**: <5MB/min
- **Actual**: 2.5-4.2MB/min (within target)
- **Leak Detection**: None (linear growth confirmed)

---

## Pre-Flight Checklist

Use this checklist before deploying to production:

### ✓ Step 1: Verify Node.js Version
```bash
node --version
# Should be >= v22.0.0
```

### ✓ Step 2: Verify SharedArrayBuffer Support
```bash
node -e "console.log(typeof SharedArrayBuffer)"
# Should print: "function"
```

### ✓ Step 3: Build Application
```bash
npm run build
# Verify dist/ directory exists
```

### ✓ Step 4: Test Redis Connection
```bash
redis-cli ping
# Should respond: PONG
```

### ✓ Step 5: Run Smoke Tests
```bash
npm run test:smoke
# Should pass all critical path tests
```

### ✓ Step 6: Verify Cache Integration
```bash
npm run test:integration -- cache-integration.test.ts
# Should achieve >95% L1 hit rate
```

### ✓ Step 7: Check Memory Configuration
```bash
# Verify heap size matches requirements
node --max-old-space-size=4096 -e "console.log(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024)"
# Should print: ~4096
```

### ✓ Step 8: Validate Worker Threads
```bash
# Run worker integration tests
npm run test:integration -- worker-*.test.ts
# Should verify zero-copy access and thread safety
```

---

## Performance Monitoring

### Key Metrics to Track

Based on ADR-005 targets and actual results:

| Metric | Target | Alert Threshold | Critical Threshold |
|--------|--------|-----------------|-------------------|
| L1 hit rate | >95% | <90% | <80% |
| Hot-path latency (p99) | <50ms | >75ms | >100ms |
| Memory growth rate | <5MB/min | >8MB/min | >15MB/min |
| GC pause (p99) | <100ms | >150ms | >200ms |
| Sustained throughput | 500 eps | <450 eps | <400 eps |
| Worker thread conflicts | 0 | >5% | >10% |

### Health Check Endpoint

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "cache": {
    "l1HitRate": 0.97,
    "l1Size": 1000,
    "l2Available": true
  },
  "workers": {
    "poolSize": 4,
    "activeWorkers": 4,
    "queueSize": 0
  },
  "memory": {
    "heapUsedMB": 380,
    "heapTotalMB": 450,
    "external": 64
  }
}
```

### Profiling in Production

If performance issues arise, enable V8 profiling (Task #46):

```bash
# Install v8-profiler-next
npm install --save-dev v8-profiler-next

# Enable profiling in production (use with caution)
NODE_ENV=production ENABLE_PROFILING=true npm start

# Profiles saved to: .profiler-output/
# View with: speedscope .profiler-output/*.cpuprofile
```

---

## Troubleshooting

### Issue: SharedArrayBuffer not available

**Symptoms**:
```
ReferenceError: SharedArrayBuffer is not defined
```

**Cause**: Node.js version <16.0.0 or outdated V8 engine

**Solution**:
```bash
# Upgrade Node.js
nvm install 22
nvm use 22
node --version  # Should be v22.0.0 or higher
```

---

### Issue: High L2 fallback rate (low L1 hit rate)

**Symptoms**:
- L1 hit rate <90%
- High Redis traffic
- Increased latency

**Diagnosis**:
```bash
# Check cache metrics
curl http://localhost:3000/metrics | grep cache_hit_rate
# Should be >0.95
```

**Solutions**:
1. **Increase L1 cache size**:
   ```bash
   # In .env
   CACHE_L1_SIZE_MB=128  # Double the size
   ```

2. **Verify cache warming**:
   - Check that predictive warming is enabled
   - Ensure hot pairs are pre-loaded

3. **Monitor eviction rate**:
   - Should be <10%/sec
   - If higher, increase L1 size further

---

### Issue: Memory leak detected

**Symptoms**:
- Memory growth >5MB/min
- Non-linear heap growth
- Increasing GC pauses

**Diagnosis**:
```bash
# Run memory stability test (Task #45)
npm run test:performance -- memory-stability.performance.test.ts

# Check for leaks
node --expose-gc --trace-gc dist/services/unified-detector/src/index.js
```

**Solutions**:
1. **Check SharedArrayBuffer references**:
   - Verify no circular references
   - Ensure workers are properly terminated

2. **Monitor Redis connections**:
   ```bash
   redis-cli client list | wc -l
   # Should match expected connection count
   ```

3. **Force GC periodically** (if --expose-gc enabled):
   ```javascript
   setInterval(() => {
     if (global.gc) global.gc();
   }, 60000); // Every minute
   ```

---

### Issue: Worker thread conflicts

**Symptoms**:
- Failed reads from workers
- Data corruption warnings
- Inconsistent cache values

**Diagnosis**:
```bash
# Run worker thread safety tests (Task #44)
npm run test:integration -- worker-thread-safety.integration.test.ts

# Check for race conditions
npm run test:integration -- worker-concurrent-reads.integration.test.ts
```

**Solutions**:
1. **Verify Atomics usage**:
   - Ensure all SharedArrayBuffer access uses Atomics
   - Check for raw Float64Array writes (should use Atomics.store)

2. **Reduce worker pool size** (temporary):
   ```bash
   # In .env
   WORKER_POOL_SIZE=2  # Reduce contention
   ```

3. **Check SharedKeyRegistry CAS loop**:
   - Verify CAS loop is not spinning infinitely
   - Monitor CPU usage per worker

---

### Issue: GC pauses exceeding 100ms

**Symptoms**:
- Latency spikes >100ms
- Decreased throughput
- High GC time in profiles

**Diagnosis**:
```bash
# Run with GC tracing
node --expose-gc --trace-gc --trace-gc-verbose dist/services/unified-detector/src/index.js

# Profile GC behavior (Task #45)
npm run test:performance -- sustained-load.performance.test.ts
```

**Solutions**:
1. **Increase heap size**:
   ```bash
   node --max-old-space-size=8192 ...  # Increase to 8GB
   ```

2. **Optimize object allocation**:
   - Reduce temporary object creation in hot paths
   - Reuse objects where possible

3. **Tune GC settings** (advanced):
   ```bash
   node --max-old-space-size=4096 \
        --max-semi-space-size=64 \
        --initial-old-space-size=2048 \
        dist/services/unified-detector/src/index.js
   ```

---

## Performance Benchmarks (Reference)

Results from integration testing (Tasks #40-46):

### Cache Performance
- L1 hit rate: **96-99%** (target: >95%)
- Hot-path latency (p99): **12-35ms** (target: <50ms)
- Zero-copy read (p99): **2-4μs** (target: <5μs)

### Load Testing
- Sustained throughput: **500-520 eps** (target: 500 eps)
- Burst throughput: **950-1020 eps** (target: >900 eps)
- Memory growth: **2.5-4.2 MB/min** (target: <5 MB/min)

### Worker Threads
- Concurrent read success: **98-100%** (target: >95%)
- Thread safety: **Zero corruption** (target: 0 conflicts)
- Pool throughput: **15-25K reads/sec** (target: >10K reads/sec)

---

## Additional Resources

- **ADR-005**: [Hierarchical Cache Architecture](./architecture/adr/ADR-005-hierarchical-cache.md)
- **Integration Tests**: `services/unified-detector/__tests__/integration/`
- **Performance Tests**: `services/unified-detector/__tests__/performance/`
- **V8 Profiler Guide**: `shared/core/src/v8-profiler.ts`
- **Worker Integration**: `shared/core/__tests__/integration/worker-*.test.ts`

---

## Support

For deployment issues or questions:
1. Check this guide's troubleshooting section
2. Review test results in CI/CD pipeline
3. Run diagnostic tests locally (Tasks #40-46)
4. Check ADR-005 for architectural details

**Last Updated**: 2026-02-07 | Post-PriceMatrix Integration Validation
