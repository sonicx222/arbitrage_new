/**
 * Tests for deferred item tracking registry.
 *
 * Validates the machine-readable registry of deferred work items,
 * ensuring data integrity and correct filtering by status.
 *
 * @see shared/config/src/deferred-items.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  DEFERRED_ITEMS,
  getUnresolvedDeferredItems,
  getDeferredItemsByStatus,
  type DeferredItem,
  type DeferredItemStatus,
} from '../../src/deferred-items';

describe('deferred-items', () => {
  // ==========================================================================
  // DEFERRED_ITEMS registry
  // ==========================================================================

  describe('DEFERRED_ITEMS', () => {
    it('should have 7 items', () => {
      expect(DEFERRED_ITEMS).toHaveLength(7);
    });

    it('each item should have a non-empty id', () => {
      for (const item of DEFERRED_ITEMS) {
        expect(item.id).toBeTruthy();
        expect(item.id.length).toBeGreaterThan(0);
      }
    });

    it('each item should have a non-empty description', () => {
      for (const item of DEFERRED_ITEMS) {
        expect(item.description).toBeTruthy();
        expect(item.description.length).toBeGreaterThan(0);
      }
    });

    it('each item should have a non-empty blocker', () => {
      for (const item of DEFERRED_ITEMS) {
        expect(item.blocker).toBeTruthy();
        expect(item.blocker.length).toBeGreaterThan(0);
      }
    });

    it('each item should have a non-empty files array', () => {
      for (const item of DEFERRED_ITEMS) {
        expect(Array.isArray(item.files)).toBe(true);
        expect(item.files.length).toBeGreaterThan(0);
      }
    });

    it('each item should have a valid status', () => {
      const validStatuses: DeferredItemStatus[] = ['deferred', 'stub', 'todo'];
      for (const item of DEFERRED_ITEMS) {
        expect(validStatuses).toContain(item.status);
      }
    });

    it('all item IDs should be unique', () => {
      const ids = DEFERRED_ITEMS.map(item => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ==========================================================================
  // getUnresolvedDeferredItems
  // ==========================================================================

  describe('getUnresolvedDeferredItems', () => {
    it('should return all items', () => {
      const items = getUnresolvedDeferredItems();
      expect(items).toHaveLength(DEFERRED_ITEMS.length);
    });

    it('should return the same items as DEFERRED_ITEMS', () => {
      const items = getUnresolvedDeferredItems();
      for (const item of DEFERRED_ITEMS) {
        expect(items).toContain(item);
      }
    });
  });

  // ==========================================================================
  // getDeferredItemsByStatus
  // ==========================================================================

  describe('getDeferredItemsByStatus', () => {
    it('should return only stub items for status=stub', () => {
      const stubs = getDeferredItemsByStatus('stub');
      expect(stubs).toHaveLength(2);
      const stubIds = stubs.map(item => item.id);
      expect(stubIds).toContain('D5-MODE-DEX-VERIFICATION');
      expect(stubIds).toContain('D9-MANTLE-MODE-PARTITIONS');
      for (const item of stubs) {
        expect(item.status).toBe('stub');
      }
    });

    it('should return only deferred items for status=deferred', () => {
      const deferred = getDeferredItemsByStatus('deferred');
      expect(deferred).toHaveLength(5);
      for (const item of deferred) {
        expect(item.status).toBe('deferred');
      }
    });

    it('should return empty array for status=todo (none exist)', () => {
      const todos = getDeferredItemsByStatus('todo');
      expect(todos).toHaveLength(0);
    });

    it('D5 should reference per-chain mode file', () => {
      const d5 = DEFERRED_ITEMS.find(i => i.id === 'D5-MODE-DEX-VERIFICATION');
      expect(d5).toBeDefined();
      expect(d5!.status).toBe('stub');
      expect(d5!.files).toContain('dexes/chains/mode.ts');
    });

    it('stub + deferred counts should equal total items', () => {
      const stubs = getDeferredItemsByStatus('stub');
      const deferred = getDeferredItemsByStatus('deferred');
      const todos = getDeferredItemsByStatus('todo');
      expect(stubs.length + deferred.length + todos.length).toBe(DEFERRED_ITEMS.length);
    });
  });
});
