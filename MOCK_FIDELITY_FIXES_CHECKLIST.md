# Mock Fidelity Fixes - Implementation Checklist

## 🔴 Tier 1: CRITICAL (P0 - This Sprint)

### [ ] Fix 1: Implement HMAC Signing in RedisMock

**File:** `shared/test-utils/src/mocks/redis.mock.ts`

**Changes:**
- [ ] Add `crypto` import
- [ ] Add `signingKey` parameter to RedisMockOptions
- [ ] Store `signingKey` in constructor
- [ ] Implement `signMessage(data: string): string` private method
- [ ] Implement `verifySignature(data: string, sig: string): boolean` private method
- [ ] Update `xadd()` to add 'sig' field when signing enabled
- [ ] Update `xread()` to verify signatures and reject invalid messages
- [ ] Update `xreadgroup()` to verify signatures and reject invalid messages

**Code Template:**
```typescript
// In RedisMock constructor
private signingKey: string | null;

constructor(options: RedisMockOptions = {}) {
  this.signingKey = options.signingKey ?? null;
}

private signMessage(data: string): string {
  if (!this.signingKey) return '';
  return crypto.createHmac('sha256', this.signingKey).update(data).digest('hex');
}

private verifySignature(data: string, signature: string): boolean {
  if (!this.signingKey) return true;
  const expected = this.signMessage(data);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// In xadd(): Add signature field
const dataStr = JSON.stringify(data);
const sig = this.signMessage(dataStr);
const fields = { data: dataStr };
if (sig) fields['sig'] = sig;
```

**Test Coverage:**
- [ ] Test: Sign message produces valid HMAC
- [ ] Test: Verify signature accepts valid signature
- [ ] Test: Verify signature rejects tampered data
- [ ] Test: Verify signature rejects invalid signature
- [ ] Test: Signing disabled when key not provided
- [ ] Test: xread rejects unsigned messages when signing enabled

**Estimated Time:** 1.5 hours

---

### [ ] Fix 2: Implement Stream Trimming (MAXLEN)

**File:** `shared/test-utils/src/mocks/redis.mock.ts`

**Changes:**
- [ ] Parse MAXLEN from xadd args
- [ ] Parse '~' for approximate vs exact trimming
- [ ] Enforce maxLen limit on stream
- [ ] Return trimmed count

**Code Template:**
```typescript
async xadd(stream: string, id: string, ...fieldValues: string[]): Promise<string> {
  const streamData = this.streams.get(stream) || [];

  // Parse MAXLEN from args
  let maxLen: number | undefined;
  let approximate = true;
  for (let i = 0; i < fieldValues.length; i++) {
    if (fieldValues[i] === 'MAXLEN') {
      if (fieldValues[i + 1] === '~') {
        approximate = true;
        maxLen = parseInt(fieldValues[i + 2]);
        i += 2;
      } else {
        approximate = false;
        maxLen = parseInt(fieldValues[i + 1]);
        i += 1;
      }
      break;
    }
  }

  // Add message
  const messageId = id === '*' ? `${Date.now()}-${sequence}` : id;
  streamData.push({ id: messageId, fields });

  // Enforce MAXLEN
  if (maxLen && streamData.length > maxLen) {
    const toRemove = streamData.length - maxLen;
    streamData.splice(0, toRemove);
  }

  this.streams.set(stream, streamData);
  return messageId;
}
```

**Test Coverage:**
- [ ] Test: XADD with MAXLEN trims stream
- [ ] Test: MAXLEN approximate trimming works
- [ ] Test: MAXLEN exact trimming works
- [ ] Test: Stream grows unbounded without MAXLEN
- [ ] Test: Multiple consecutive ADDs respect MAXLEN

**Estimated Time:** 1 hour

---

### [ ] Fix 3: Implement Consumer Group Pending List Tracking

**File:** `shared/test-utils/src/mocks/redis.mock.ts`

**Changes:**
- [ ] Update ConsumerGroupState interface to include pending map
- [ ] Track pending messages in xreadgroup()
- [ ] Remove from pending in xack()
- [ ] Support XREADGROUP with '0' for pending messages

**Code Template:**
```typescript
interface ConsumerGroupState {
  lastDeliveredId: string;
  consumers: Map<string, ConsumerState>;
}

interface ConsumerState {
  name: string;
  pending: Map<string, string>; // messageId -> deliveryTime
}

// In xreadgroup():
if (startId === '0') {
  // Return pending messages for this consumer
  const pending = consumerState.pending.entries();
  messages = streamData.filter(msg => pending.has(msg.id));
} else if (startId === '>') {
  // Return new messages
  const messages = streamData.filter(msg => msg.id > lastId);
  // Add to consumer's pending list
  messages.forEach(msg => consumerState.pending.set(msg.id, Date.now()));
}

// In xack():
const consumerState = group.consumers.get(consumerName);
if (consumerState) {
  ids.forEach(id => consumerState.pending.delete(id));
}
```

**Test Coverage:**
- [ ] Test: XREADGROUP with '>' returns new messages
- [ ] Test: XREADGROUP with '>' adds to pending list
- [ ] Test: XREADGROUP with '0' returns pending messages
- [ ] Test: XACK removes from pending list
- [ ] Test: Consumer can replay pending messages
- [ ] Test: Multiple consumers have separate pending lists

**Estimated Time:** 1.5 hours

---

### [ ] Fix 4: Implement BLOCK Timeout Simulation

**File:** `shared/test-utils/src/mocks/redis.mock.ts`

**Changes:**
- [ ] Parse BLOCK from xread args
- [ ] Simulate delay for blocking reads
- [ ] Enforce maxBlockMs cap
- [ ] Return empty if no messages after timeout

**Code Template:**
```typescript
async xread(...args: unknown[]): Promise<...> {
  const blockIdx = args.indexOf('BLOCK');
  let blockMs = 0;

  if (blockIdx >= 0) {
    blockMs = parseInt(args[blockIdx + 1]);
    const maxBlockMs = 30000; // 30 second cap
    if (blockMs === 0 || blockMs > maxBlockMs) {
      blockMs = maxBlockMs;
    }
  }

  // Simulate blocking delay
  if (blockMs > 0) {
    // Use reduced delay for tests (100ms instead of requested)
    await new Promise(resolve => setTimeout(resolve, Math.min(blockMs, 100)));
  }

  // Return messages or empty if timeout
  return messages.length > 0 ? [[streamName, messages]] : null;
}
```

**Test Coverage:**
- [ ] Test: XREAD BLOCK waits for specified time
- [ ] Test: XREAD BLOCK returns messages immediately if available
- [ ] Test: XREAD BLOCK is capped at maxBlockMs
- [ ] Test: XREAD BLOCK=0 infinite wait is capped
- [ ] Test: XREAD BLOCK returns null after timeout with no messages

**Estimated Time:** 45 minutes

---

### [ ] Fix 5: Fix XACK Pending Entry Removal

**File:** `shared/test-utils/src/mocks/redis.mock.ts`

**Changes:**
- [ ] Update xack() to actually remove from pending
- [ ] Verify pending list properly tracked

**Code Template:** (Already covered in Fix 3)

**Test Coverage:**
- [ ] Test: XACK with valid ID removes from pending
- [ ] Test: XACK with multiple IDs removes all
- [ ] Test: XACK with non-existent ID returns 0
- [ ] Test: Acknowledged messages not returned by XREADGROUP '0'

**Estimated Time:** 30 minutes (covered by Fix 3)

---

## 🟠 Tier 2: HIGH (P1 - Next Sprint)

### [ ] Fix 6: Add RedisMockOptions.signingKey Support

**Dependency:** Fix 1 complete

**File:** `shared/test-utils/src/mocks/redis.mock.ts`

**Changes:**
- [ ] Update RedisMockOptions interface to include signingKey
- [ ] Pass signingKey to RedisMock constructor
- [ ] Add helper function: `createRedisMockWithSigning(signingKey: string)`

**Test Coverage:**
- [ ] Test: RedisMock with HMAC signing enforces signatures
- [ ] Test: RedisMock without signing accepts unsigned messages

**Estimated Time:** 30 minutes

---

### [ ] Fix 7: Implement WebSocket Fallback URL Testing

**File:** `shared/core/__tests__/unit/websocket-manager.test.ts`

**Changes:**
- [ ] Add test for primary connection failure
- [ ] Add test for fallback URL retry
- [ ] Add test for exhausting all fallbacks
- [ ] Add test for fallback success

**Test Coverage:**
- [ ] Test: Primary URL fails, fallback succeeds
- [ ] Test: All fallbacks fail, error thrown
- [ ] Test: First successful fallback used
- [ ] Test: Fallback URLs tested in order

**Estimated Time:** 1 hour

---

### [ ] Fix 8: Implement Reconnection Backoff

**File:** `shared/core/__tests__/unit/websocket-manager.test.ts`

**Changes:**
- [ ] Mock exponential backoff timing
- [ ] Add test for backoff delays
- [ ] Add test for jitter

**Test Coverage:**
- [ ] Test: First reconnection attempt immediate
- [ ] Test: Second reconnection attempt delayed
- [ ] Test: Backoff increases exponentially
- [ ] Test: Max backoff enforced
- [ ] Test: Jitter prevents thundering herd

**Estimated Time:** 1 hour

---

### [ ] Fix 9: Add Opportunity Validation Edge Cases

**File:** `services/execution-engine/__tests__/unit/consumers/consumer-test-helpers.ts`

**Changes:**
- [ ] Add variants: zero profit, negative profit, zero confidence, stale timestamp

**Code Template:**
```typescript
export function createMockOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  const opp: ArbitrageOpportunity = {
    // ... existing fields
    expectedProfit: 100,  // Can be overridden
    confidence: 0.95,     // Can be overridden
    timestamp: Date.now(),  // Can be overridden
    ...overrides,
  };
  return opp;
}

// New edge case factories
export const createZeroProfitOpportunity = () => createMockOpportunity({ expectedProfit: 0 });
export const createLossOpportunity = () => createMockOpportunity({ expectedProfit: -100 });
export const createLowConfidenceOpportunity = () => createMockOpportunity({ confidence: 0.1 });
export const createStaleOpportunity = () => createMockOpportunity({ timestamp: Date.now() - 60000 });
```

**Test Coverage:**
- [ ] Test: Zero profit opportunity rejected
- [ ] Test: Negative profit opportunity rejected
- [ ] Test: Low confidence opportunity handled
- [ ] Test: Stale opportunity rejected
- [ ] Test: Boundary values (0.001 profit, 0.01 confidence)

**Estimated Time:** 1 hour

---

### [ ] Fix 10: Implement Circuit Breaker State Machine Tests

**File:** `services/execution-engine/__tests__/unit/services/circuit-breaker-manager.test.ts`

**Changes:**
- [ ] Update mock to track state transitions
- [ ] Add test for CLOSED → OPEN transition
- [ ] Add test for OPEN → HALF_OPEN transition
- [ ] Add test for HALF_OPEN → CLOSED transition
- [ ] Add test for failure count thresholds

**Test Coverage:**
- [ ] Test: State machine follows CLOSED → OPEN → HALF_OPEN → CLOSED
- [ ] Test: Failure count triggers state change
- [ ] Test: Success count resets failures
- [ ] Test: Cooldown prevents immediate retry
- [ ] Test: Concurrent calls handled correctly

**Estimated Time:** 1.5 hours

---

## 📋 Testing Checklist

After implementing Tier 1 fixes:

- [ ] Run `npm test -- redis.mock.test.ts` (create this test file)
- [ ] Run `npm test -- redis-streams` (verify existing tests still pass)
- [ ] Run `npm test -- websocket-manager` (verify existing tests still pass)
- [ ] Run `npm test -- circuit-breaker-manager` (verify existing tests still pass)
- [ ] Run `npm run test:unit` (full unit test suite)
- [ ] Verify no test regressions
- [ ] Verify mock fidelity improved

---

## Sign-Off Template

**Tier 1 Fixes Complete:**

- [ ] Fix 1: HMAC Signing - ✅ Implemented & Tested
- [ ] Fix 2: MAXLEN Trimming - ✅ Implemented & Tested
- [ ] Fix 3: Pending List - ✅ Implemented & Tested
- [ ] Fix 4: BLOCK Timeout - ✅ Implemented & Tested
- [ ] Fix 5: XACK Semantics - ✅ Implemented & Tested

**Review:** Verified that mock behavior now matches production for S-5, P1-3, P1-8 fixes

**Test Results:** All new tests passing, no regressions

**Mock Fidelity Score:** 2.5/5 → 4.0/5

---

## Reference

**Full details:** `MOCK_FIDELITY_VALIDATION_REPORT.md` (lines noted for each gap)
**Executive summary:** `MOCK_FIDELITY_EXECUTIVE_SUMMARY.md`
