# Technical Debt & Future Work

> **Last Updated:** 2026-02-05
> **Maintained by:** Development Team

This document tracks technical debt, future enhancements, and ongoing considerations that don't warrant full ADRs.

---

## Active Technical Debt

### P1 - Should Address Soon

| ID | Area | Description | Added |
|----|------|-------------|-------|
| TD-001 | RPC | Analysis to reduce RPC load - consider more aggressive caching | 2026-02-05 |
| TD-002 | Hosting | Evaluate new free hosting providers as limits change | 2026-02-05 |
| TD-003 | Redis | Audit Redis Streams/groups for correct flow from detection → execution | 2026-02-05 |

### P2 - Address When Convenient

| ID | Area | Description | Added |
|----|------|-------------|-------|
| TD-004 | Config | Dynamic partition assignment based on enabled chains | 2026-02-05 |
| TD-005 | Reports | Consolidate assessment reports into single format | 2026-02-05 |
| TD-006 | Docs | Add API reference documentation (OpenAPI) | 2026-02-05 |

### P3 - Nice to Have

| ID | Area | Description | Added |
|----|------|-------------|-------|
| TD-007 | Ops | Create operations runbook for production incidents | 2026-02-05 |
| TD-008 | Config | Centralize all environment variable documentation | 2026-02-05 |

---

## Future Research Topics

These require investigation before implementation:

| Topic | Question | Status |
|-------|----------|--------|
| **New Chains** | Which blockchains should be added next? | Evaluate Sonic (Fantom rebrand) |
| **Binary Protocols** | Would MessagePack improve event parsing latency? | Need benchmarks |
| **Orderflow Prediction** | ML model for predicting trade success | Research phase |
| **Performance Profiling** | Automated regression detection | Deferred from v3 |

---

## Completed Items (Archive)

Items marked complete are moved here for reference:

| ID | Description | Completed | Resolution |
|----|-------------|-----------|------------|
| ~~TD-000~~ | Fix documentation cross-references | 2026-02-05 | README.md updated |

---

## How to Use This Document

1. **Adding items**: Include ID, area, description, and date added
2. **Prioritization**: P1 (soon), P2 (convenient), P3 (nice to have)
3. **Completing items**: Move to archive section with resolution
4. **Large items**: Create an ADR instead if architectural impact

**Related:**
- [ADR Index](architecture/adr/README.md) - For architectural decisions
- [DECISION_LOG.md](architecture/DECISION_LOG.md) - For operational decisions
