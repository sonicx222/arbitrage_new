# Mock Fidelity Quick Reference

**TL;DR:** Tests pass but mocks skip 5+ critical production behaviors. Fix list below.

---

## The 5 Critical Issues

| Issue | Real Behavior | Mock Behavior | Test Risk |
|-------|---------------|---------------|-----------|
| 1️⃣ HMAC Signing | Adds 'sig' field, rejects invalid | No 'sig' field | Tampered messages pass tests |
| 2️⃣ Stream Trimming | MAXLEN caps stream size | Grows unbounded | Memory leak undetected |
| 3️⃣ Pending List | XACK removes from pending | No tracking | Crash recovery untested |
| 4️⃣ BLOCK Timeout | Capped at 30s | Not enforced | Indefinite waits possible |
| 5️⃣ Consumer State | Tracks new vs pending | No distinction | Recovery untested |

---

## One-Sentence Impact

**Current mocks allow tests to pass for behaviors that fail in production.**

---

## Quick Fixes

### Issue 1: HMAC Signing
```typescript
// File: shared/test-utils/src/mocks/redis.mock.ts
// Add to xadd():
const sig = crypto.createHmac('sha256', signingKey).update(data).digest('hex');
fields['sig'] = sig;

// Add to xread():
if (signingKey && !verifySignature(data, sig)) {
  skip this message  // Reject like production
}
```

### Issue 2: Stream Trimming
```typescript
// In xadd():
if (maxLen && streamData.length > maxLen) {
  streamData.splice(0, streamData.length - maxLen);
}
```

### Issue 3: Pending List
```typescript
// Track in xreadgroup():
consumerPending.set(messageId, Date.now());

// Remove in xack():
consumerPending.delete(messageId);
```

### Issue 4: BLOCK Timeout
```typescript
// In xread():
const maxBlockMs = 30000;
const effectiveBlock = Math.min(blockMs, maxBlockMs);
await delay(effectiveBlock);
```

### Issue 5: Consumer State
```typescript
// In xreadgroup():
if (startId === '0') return pending messages;
if (startId === '>') return new messages;
```

---

## Files to Review

### Main Report
📄 `MOCK_FIDELITY_VALIDATION_REPORT.md` (400+ lines, detailed analysis)

### Executive Summary
📄 `MOCK_FIDELITY_EXECUTIVE_SUMMARY.md` (visual, risk-focused)

### Implementation Guide
📄 `MOCK_FIDELITY_FIXES_CHECKLIST.md` (step-by-step with tests)

### This File
📄 `.agent-reports/MOCK_FIDELITY_QUICK_REFERENCE.md` (you are here)

---

## Test Impact

**Tier 1 Fixes (5 issues):** ~6 hours → Closes 75% of false-positive risk
**Tier 2 Fixes (4 issues):** ~4 hours → Covers high-risk paths
**Tier 3 Fixes (4 issues):** ~3 hours → Polish

---

## Status

- 📊 Analysis: ✅ Complete
- 🔧 Implementation: ⏳ Pending
- 📋 Testing: ⏳ Pending

---

**Key Insight:** Mocks make tests fast but sacrifice fidelity. Current gaps create false confidence. Fix list prioritizes highest-risk items.
