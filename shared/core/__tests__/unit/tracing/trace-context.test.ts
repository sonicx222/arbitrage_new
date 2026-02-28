/**
 * Unit tests for TraceContext — cross-service trace context propagation.
 *
 * Tests cover:
 * - Trace ID generation (W3C format: 32 hex chars)
 * - Span ID generation (W3C format: 16 hex chars)
 * - Root context creation
 * - Child context creation (inherits traceId, new spanId)
 * - Context propagation (inject into message)
 * - Context extraction (extract from message)
 * - Invalid/missing field handling
 * - Trace field stripping
 */

import {
  generateTraceId,
  generateSpanId,
  createTraceContext,
  createFastTraceContext,
  resetFastTraceCounter,
  createChildContext,
  propagateContext,
  extractContext,
  stripTraceFields,
  TRACE_FIELDS,
} from '../../../src/tracing/trace-context';
import type { TraceContext } from '../../../src/tracing/trace-context';

// =============================================================================
// ID Generation
// =============================================================================

describe('generateTraceId', () => {
  it('should return a 32-character hex string', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toHaveLength(32);
  });

  it('should generate unique IDs on successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTraceId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('generateSpanId', () => {
  it('should return a 16-character hex string', () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).toHaveLength(16);
  });

  it('should generate unique IDs on successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateSpanId());
    }
    expect(ids.size).toBe(100);
  });
});

// =============================================================================
// Context Creation
// =============================================================================

describe('createTraceContext', () => {
  it('should create a root context with valid traceId and spanId', () => {
    const ctx = createTraceContext('coordinator');

    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.serviceName).toBe('coordinator');
    expect(ctx.parentSpanId).toBeUndefined();
    expect(ctx.timestamp).toBeGreaterThan(0);
  });

  it('should set timestamp close to current time', () => {
    const before = Date.now();
    const ctx = createTraceContext('detector');
    const after = Date.now();

    expect(ctx.timestamp).toBeGreaterThanOrEqual(before);
    expect(ctx.timestamp).toBeLessThanOrEqual(after);
  });

  it('should generate unique contexts on successive calls', () => {
    const ctx1 = createTraceContext('svc-a');
    const ctx2 = createTraceContext('svc-b');

    expect(ctx1.traceId).not.toBe(ctx2.traceId);
    expect(ctx1.spanId).not.toBe(ctx2.spanId);
  });
});

describe('createChildContext', () => {
  let parentCtx: TraceContext;

  beforeEach(() => {
    parentCtx = createTraceContext('parent-service');
  });

  it('should inherit traceId from parent', () => {
    const child = createChildContext(parentCtx, 'child-service');

    expect(child.traceId).toBe(parentCtx.traceId);
  });

  it('should generate a new spanId', () => {
    const child = createChildContext(parentCtx, 'child-service');

    expect(child.spanId).not.toBe(parentCtx.spanId);
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should set parentSpanId to parent spanId', () => {
    const child = createChildContext(parentCtx, 'child-service');

    expect(child.parentSpanId).toBe(parentCtx.spanId);
  });

  it('should use the child service name', () => {
    const child = createChildContext(parentCtx, 'execution-engine');

    expect(child.serviceName).toBe('execution-engine');
  });

  it('should set a fresh timestamp', () => {
    const child = createChildContext(parentCtx, 'child-service');

    expect(child.timestamp).toBeGreaterThanOrEqual(parentCtx.timestamp);
  });

  it('should support multi-level nesting', () => {
    const child = createChildContext(parentCtx, 'middle');
    const grandchild = createChildContext(child, 'leaf');

    // All share the same traceId
    expect(grandchild.traceId).toBe(parentCtx.traceId);

    // Each has distinct spanId
    expect(grandchild.spanId).not.toBe(child.spanId);
    expect(grandchild.spanId).not.toBe(parentCtx.spanId);

    // Grandchild points to child
    expect(grandchild.parentSpanId).toBe(child.spanId);
  });
});

// =============================================================================
// Propagation
// =============================================================================

describe('propagateContext', () => {
  let ctx: TraceContext;

  beforeEach(() => {
    ctx = createTraceContext('detector');
  });

  it('should inject trace fields into the message', () => {
    const message = { type: 'price_update', price: '1.23' };
    const enriched = propagateContext(message, ctx);

    expect(enriched[TRACE_FIELDS.traceId]).toBe(ctx.traceId);
    expect(enriched[TRACE_FIELDS.spanId]).toBe(ctx.spanId);
    expect(enriched[TRACE_FIELDS.serviceName]).toBe('detector');
    expect(enriched[TRACE_FIELDS.timestamp]).toBe(String(ctx.timestamp));
  });

  it('should not mutate the original message', () => {
    const message = { type: 'event' };
    const enriched = propagateContext(message, ctx);

    expect(message).not.toHaveProperty(TRACE_FIELDS.traceId);
    expect(enriched).toHaveProperty(TRACE_FIELDS.traceId);
  });

  it('should preserve existing message fields', () => {
    const message = { type: 'swap', amount: '100' };
    const enriched = propagateContext(message, ctx);

    expect(enriched.type).toBe('swap');
    expect(enriched.amount).toBe('100');
  });

  it('should include parentSpanId when present', () => {
    const parent = createTraceContext('parent');
    const child = createChildContext(parent, 'child');
    const enriched = propagateContext({}, child);

    expect(enriched[TRACE_FIELDS.parentSpanId]).toBe(parent.spanId);
  });

  it('should omit parentSpanId when not present', () => {
    const enriched = propagateContext({}, ctx);

    expect(enriched).not.toHaveProperty(TRACE_FIELDS.parentSpanId);
  });
});

// =============================================================================
// Extraction
// =============================================================================

describe('extractContext', () => {
  it('should extract a valid context from an enriched message', () => {
    const original = createTraceContext('source');
    const message = propagateContext({ data: 'test' }, original);

    const extracted = extractContext(message);

    expect(extracted).not.toBeNull();
    expect(extracted!.traceId).toBe(original.traceId);
    expect(extracted!.spanId).toBe(original.spanId);
    expect(extracted!.serviceName).toBe('source');
    expect(extracted!.timestamp).toBe(original.timestamp);
  });

  it('should extract parentSpanId when present', () => {
    const parent = createTraceContext('parent');
    const child = createChildContext(parent, 'child');
    const message = propagateContext({}, child);

    const extracted = extractContext(message);

    expect(extracted).not.toBeNull();
    expect(extracted!.parentSpanId).toBe(parent.spanId);
  });

  it('should return null when traceId is missing', () => {
    const message = {
      [TRACE_FIELDS.spanId]: generateSpanId(),
      [TRACE_FIELDS.serviceName]: 'svc',
    };

    expect(extractContext(message)).toBeNull();
  });

  it('should return null when spanId is missing', () => {
    const message = {
      [TRACE_FIELDS.traceId]: generateTraceId(),
      [TRACE_FIELDS.serviceName]: 'svc',
    };

    expect(extractContext(message)).toBeNull();
  });

  it('should return null when serviceName is missing', () => {
    const message = {
      [TRACE_FIELDS.traceId]: generateTraceId(),
      [TRACE_FIELDS.spanId]: generateSpanId(),
    };

    expect(extractContext(message)).toBeNull();
  });

  it('should return null for invalid traceId format', () => {
    const message = {
      [TRACE_FIELDS.traceId]: 'not-a-valid-trace-id',
      [TRACE_FIELDS.spanId]: generateSpanId(),
      [TRACE_FIELDS.serviceName]: 'svc',
    };

    expect(extractContext(message)).toBeNull();
  });

  it('should return null for invalid spanId format', () => {
    const message = {
      [TRACE_FIELDS.traceId]: generateTraceId(),
      [TRACE_FIELDS.spanId]: 'short',
      [TRACE_FIELDS.serviceName]: 'svc',
    };

    expect(extractContext(message)).toBeNull();
  });

  it('should return null for uppercase hex IDs', () => {
    const message = {
      [TRACE_FIELDS.traceId]: generateTraceId().toUpperCase(),
      [TRACE_FIELDS.spanId]: generateSpanId(),
      [TRACE_FIELDS.serviceName]: 'svc',
    };

    expect(extractContext(message)).toBeNull();
  });

  it('should use current time when timestamp is invalid', () => {
    const before = Date.now();
    const message = {
      [TRACE_FIELDS.traceId]: generateTraceId(),
      [TRACE_FIELDS.spanId]: generateSpanId(),
      [TRACE_FIELDS.serviceName]: 'svc',
      [TRACE_FIELDS.timestamp]: 'not-a-number',
    };

    const extracted = extractContext(message);
    const after = Date.now();

    expect(extracted).not.toBeNull();
    expect(extracted!.timestamp).toBeGreaterThanOrEqual(before);
    expect(extracted!.timestamp).toBeLessThanOrEqual(after);
  });

  it('should ignore invalid parentSpanId format', () => {
    const message = {
      [TRACE_FIELDS.traceId]: generateTraceId(),
      [TRACE_FIELDS.spanId]: generateSpanId(),
      [TRACE_FIELDS.serviceName]: 'svc',
      [TRACE_FIELDS.timestamp]: String(Date.now()),
      [TRACE_FIELDS.parentSpanId]: 'invalid-parent',
    };

    const extracted = extractContext(message);

    expect(extracted).not.toBeNull();
    expect(extracted!.parentSpanId).toBeUndefined();
  });

  it('should return null for empty message', () => {
    expect(extractContext({})).toBeNull();
  });

  it('should return null when fields have non-string types', () => {
    const message = {
      [TRACE_FIELDS.traceId]: 12345,
      [TRACE_FIELDS.spanId]: true,
      [TRACE_FIELDS.serviceName]: null,
    };

    expect(extractContext(message as Record<string, unknown>)).toBeNull();
  });
});

// =============================================================================
// Round-trip: propagate -> extract
// =============================================================================

describe('propagateContext + extractContext round-trip', () => {
  it('should preserve context through propagation and extraction', () => {
    const original = createTraceContext('source-service');
    const message = propagateContext({ key: 'value' }, original);
    const extracted = extractContext(message);

    expect(extracted).not.toBeNull();
    expect(extracted!.traceId).toBe(original.traceId);
    expect(extracted!.spanId).toBe(original.spanId);
    expect(extracted!.serviceName).toBe(original.serviceName);
    expect(extracted!.timestamp).toBe(original.timestamp);
  });

  it('should preserve parent-child chain through round-trip', () => {
    const parent = createTraceContext('svc-a');
    const child = createChildContext(parent, 'svc-b');

    const message = propagateContext({}, child);
    const extracted = extractContext(message);

    expect(extracted).not.toBeNull();
    expect(extracted!.traceId).toBe(parent.traceId);
    expect(extracted!.parentSpanId).toBe(parent.spanId);
    expect(extracted!.spanId).toBe(child.spanId);
  });
});

// =============================================================================
// Strip Trace Fields
// =============================================================================

describe('stripTraceFields', () => {
  it('should remove all trace-prefixed fields', () => {
    const ctx = createTraceContext('svc');
    const message = propagateContext({ type: 'update', price: '1.5' }, ctx);

    const stripped = stripTraceFields(message);

    expect(stripped).toEqual({ type: 'update', price: '1.5' });
    expect(stripped).not.toHaveProperty(TRACE_FIELDS.traceId);
    expect(stripped).not.toHaveProperty(TRACE_FIELDS.spanId);
    expect(stripped).not.toHaveProperty(TRACE_FIELDS.serviceName);
    expect(stripped).not.toHaveProperty(TRACE_FIELDS.timestamp);
  });

  it('should not mutate the input message', () => {
    const ctx = createTraceContext('svc');
    const message = propagateContext({ data: '1' }, ctx);
    const original = { ...message };

    stripTraceFields(message);

    expect(message).toEqual(original);
  });

  it('should return all fields when no trace fields present', () => {
    const message = { a: 1, b: 'two', c: true };
    const stripped = stripTraceFields(message);

    expect(stripped).toEqual(message);
  });

  it('should return empty object for empty input', () => {
    expect(stripTraceFields({})).toEqual({});
  });
});

// =============================================================================
// TRACE_FIELDS constants
// =============================================================================

// =============================================================================
// Fast Trace Context (Regression tests for FIX C1)
// =============================================================================

describe('createFastTraceContext', () => {
  beforeEach(() => {
    resetFastTraceCounter();
  });

  it('should return a valid TraceContext with 32-char traceId and 16-char spanId', () => {
    const ctx = createFastTraceContext('test-service');

    expect(ctx.traceId).toHaveLength(32);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toHaveLength(16);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.serviceName).toBe('test-service');
    expect(ctx.timestamp).toBeGreaterThan(0);
  });

  it('should generate unique IDs on successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(createFastTraceContext('svc').traceId);
    }
    // All 1000 should be unique (counter-based guarantees this)
    expect(ids.size).toBe(1000);
  });

  it('should generate unique spanIds on successive calls', () => {
    const spanIds = new Set<string>();
    for (let i = 0; i < 100; i++) {
      spanIds.add(createFastTraceContext('svc').spanId);
    }
    expect(spanIds.size).toBe(100);
  });

  it('should not use crypto.randomBytes (no 16-byte entropy)', () => {
    // Fast context uses deterministic counter-based IDs.
    // Verify by checking the traceId contains the service name hash component
    // (same service always produces same hash portion)
    const ctx1 = createFastTraceContext('detector');
    const ctx2 = createFastTraceContext('detector');

    // Last 12 chars are the service name hash — should be identical for same service
    const hash1 = ctx1.traceId.slice(20);
    const hash2 = ctx2.traceId.slice(20);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hash components for different service names', () => {
    const ctx1 = createFastTraceContext('service-a');
    const ctx2 = createFastTraceContext('service-b');

    // Last 12 chars are the service name hash
    const hash1 = ctx1.traceId.slice(20);
    const hash2 = ctx2.traceId.slice(20);
    expect(hash1).not.toBe(hash2);
  });

  it('should set timestamp close to current time', () => {
    const before = Date.now();
    const ctx = createFastTraceContext('svc');
    const after = Date.now();

    expect(ctx.timestamp).toBeGreaterThanOrEqual(before);
    expect(ctx.timestamp).toBeLessThanOrEqual(after);
  });

  it('should produce extractable context when used with TRACE_FIELDS', () => {
    // Regression: ensure fast contexts are compatible with the extraction pipeline
    const ctx = createFastTraceContext('chain-detector:ethereum');
    const message: Record<string, unknown> = { type: 'price_update' };

    // Manually inject (mirrors the hot-path code in chain-instance.ts)
    message[TRACE_FIELDS.traceId] = ctx.traceId;
    message[TRACE_FIELDS.spanId] = ctx.spanId;
    message[TRACE_FIELDS.serviceName] = ctx.serviceName;
    message[TRACE_FIELDS.timestamp] = String(ctx.timestamp);

    const extracted = extractContext(message);
    expect(extracted).not.toBeNull();
    expect(extracted!.traceId).toBe(ctx.traceId);
    expect(extracted!.spanId).toBe(ctx.spanId);
    expect(extracted!.serviceName).toBe('chain-detector:ethereum');
  });
});

describe('TRACE_FIELDS', () => {
  it('should have the expected field names with _trace_ prefix', () => {
    expect(TRACE_FIELDS.traceId).toBe('_trace_traceId');
    expect(TRACE_FIELDS.spanId).toBe('_trace_spanId');
    expect(TRACE_FIELDS.parentSpanId).toBe('_trace_parentSpanId');
    expect(TRACE_FIELDS.serviceName).toBe('_trace_serviceName');
    expect(TRACE_FIELDS.timestamp).toBe('_trace_timestamp');
  });
});
