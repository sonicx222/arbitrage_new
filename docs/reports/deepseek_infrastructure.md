Looking at the provided codebase, I notice that **the `/infrastructure` directory content is NOT included in the repomix output**. I can only see the directory structure and some documentation files, but not the actual implementation code in `/infrastructure`.

However, I CAN analyze what IS provided - particularly the ADR documents and plans that reveal architectural decisions and potential mismatches. Let me provide a deep analysis based on what I CAN see:

## 🚨 CRITICAL FINDING: Missing Infrastructure Code

**Issue**: The repomix output shows directory structure for `/infrastructure` but doesn't include the actual files. This means I cannot:
- Review `infrastructure/docker/docker-compose.yml` for dev/prod parity
- Review `infrastructure/scripts/` for deployment bugs
- Review `infrastructure/oracle/terraform/` for IaC issues

## 🔍 Analysis of What IS Provided

### 1. **Architecture vs Implementation Mismatches**

From ADR-002 (Redis Streams):
```typescript
// ADR states Pub/Sub removed, but current code may still have fallback
throw new Error('Price update batcher not initialized - Streams required per ADR-002');
```

**Finding**: The ADR claims Phase 4 (Pub/Sub removal) is complete, but without the actual code, we cannot verify if:
- All services migrated from Pub/Sub to Streams
- AdvancedArbitrageOrchestrator is actually deprecated
- No `useStreams` flags remain

### 2. **Documentation vs Code Mismatch**

From ADR-003 (Partitioned Detectors):
```
Single-Chain Detector Deprecation (2025-01-11)
All single-chain detector services are now deprecated in favor of `unified-detector`
```

**Questions without code**:
- Are `services/ethereum-detector`, `services/arbitrum-detector` actually marked as deprecated?
- Do they have `DEPRECATED.md` files as claimed?
- Is there migration guidance?

### 3. **Dev vs Prod Configuration Risks**

From directory structure:
```
infrastructure/
  docker/
    .env.partition.example     # Example config
    docker-compose.partition.yml
    docker-compose.yml
```

**Without the actual files, we cannot check**:
- Are secrets properly separated between dev/prod?
- Are there hardcoded values that should be env vars?
- Does `docker-compose.yml` match production deployment?

### 4. **Race Conditions (Documented in ADRs)**

From ADR-007 (Failover Strategy):
```typescript
// S4.1.2-FIX: Uses atomic Lua script to prevent TOCTOU race conditions
const renewed = await redis.renewLockIfOwned(lockKey, this.instanceId, 30);
```

**Critical**: This mentions a race condition fix (S4.1.2-FIX) but without the code, we cannot:
- Verify the Lua script is actually implemented
- Check if other Redis operations have similar race risks
- Confirm distributed locking works correctly

### 5. **Inconsistencies Across Architecture**

From comparing ADRs:

**Inconsistency 1**: ADR-008 (Chain Selection) lists 11 chains including Solana, but ADR-003 (Partitions) shows:
- P1: Asia-Fast (BSC, Polygon, Avalanche, Fantom)
- P2: L2-Turbo (Arbitrum, Optimism, Base) 
- P3: High-Value (Ethereum, zkSync, Linea)
- P4: Solana-Native

**Missing**: Where do zkSync and Linea go? They're in ADR-008 but not in ADR-003's partition table.

**Inconsistency 2**: ADR-010 mentions free RPC providers, but ADR-006 (Free Hosting) doesn't account for RPC rate limits in free tiers.

### 6. **Deprecated Code and TODOs**

From ADR-002:
```typescript
// AdvancedArbitrageOrchestrator Deprecated:
// @deprecated Use coordinator service pattern instead
```

**Without code, we cannot verify**:
- Is `AdvancedArbitrageOrchestrator` actually marked `@deprecated`?
- Are there `// TODO` comments in the codebase?
- Are there unused imports or functions?

### 7. **Test Coverage Gaps**

From ADR-009 (Test Architecture):
```
Current test infrastructure has evolved organically, resulting in:
1. Fragmented Organization
2. Import Inconsistencies  
3. Duplicated Mock Infrastructure
```

**Critical Testing Issues** (from what we CAN see):
- No test files shown for `/infrastructure/` at all
- ADR mentions 58 test files need migration
- Tests co-located with source in some packages, separate in others

### 8. **Refactoring Opportunities (From Plans)**

From `.claude/plans/component-architecture-proposal.md`:

**BaseDetector has 12+ responsibilities**:
- WebSocket management (~100 lines)
- Redis operations (~50 lines)  
- Event batching (~80 lines)
- Price update publishing (~60 lines)
- etc...

**This is a classic God Object anti-pattern** that violates Single Responsibility Principle.

### 9. **Performance Optimization Gaps**

From ADR-011 (Tier 1 Optimizations):

**Critical issues that need code verification**:
- T1.1: Token Pair Indexing for O(1) lookups - Is this implemented?
- T1.4: O(1) LRU Queue Operations - Array-based vs doubly-linked list?
- T1.5: Chain-Based Staleness Thresholds - Fixed 30s vs chain-specific?

### 10. **Configuration Management Risks**

From directory structure:
```
scripts/
  setup-env.js
  start-local.js
```

**Without code, we cannot check**:
- Are there hardcoded API keys?
- Is `.env` loading consistent across services?
- Are there different configs for dev/test/prod?

## 🛠️ **ACTION PLAN: What We NEED to Fix**

Since I cannot see the actual `/infrastructure` code, here's what needs investigation:

### **Phase 1: Infrastructure Code Audit** 
```bash
# Need to review these critical files:
infrastructure/docker/docker-compose.yml          # Dev/Prod parity
infrastructure/docker/docker-compose.partition.yml # Partition config
infrastructure/scripts/health-check.sh           # Race conditions?
infrastructure/oracle/terraform/main.tf          # IaC consistency
infrastructure/fly/deploy.sh                     # Deployment bugs
```

### **Phase 2: Verify ADR Implementation**
```typescript
// Check these ADR claims in actual code:
1. Is Pub/Sub truly removed? (ADR-002)
2. Are single-chain detectors deprecated? (ADR-003)  
3. Is failover locking atomic? (ADR-007)
4. Are WebSocket fallbacks configured? (ADR-010)
```

### **Phase 3: Configuration Consistency**
```bash
# Check for mismatches:
1. Compare docker-compose.yml with fly.toml
2. Compare .env.example with actual deployment
3. Check for hardcoded values vs environment variables
```

## 📋 **Immediate Checks (When Code is Available):**

1. **Race Conditions**: Look for Redis operations without atomic scripts
2. **Memory Leaks**: Check for unmanaged intervals/timeouts  
3. **Error Handling**: Verify try/catch coverage in infrastructure scripts
4. **Security**: Check for exposed secrets in config files
5. **Performance**: Profile startup time and resource usage

## 🎯 **Critical Hot Path Optimizations Needed:**

Based on ADR-011, these optimizations MUST be verified:
1. **O(1) vs O(n) pair lookups** - Critical for <50ms detection
2. **Dynamic gas pricing** - ADR-013 claims 60s cache, verify implementation
3. **Worker thread offloading** - ADR-012 mentions DFS in workers, verify

## ⚠️ **RED FLAGS (From Documentation Alone):**

1. **S4.1.2-FIX mentioned** - Race condition was found and "fixed"
2. **58 test files need migration** - Test debt accumulating
3. **God Object (BaseDetector)** - 1863 lines, 12+ responsibilities
4. **Inconsistent chain partitioning** - ADR-008 vs ADR-003 mismatch

## 📝 **Recommendation:**

**Provide the actual `/infrastructure` code files** so I can perform a proper analysis. The directory structure shows critical components that need review:

- Docker configurations
- Terraform IaC  
- Deployment scripts
- Health checks
- Failover scripts

Without these files, we're flying blind on infrastructure issues that could cause:
- Production outages
- Security vulnerabilities  
- Performance bottlenecks
- Deployment failures