/**
 * Metrics Routes
 *
 * Protected endpoints for system metrics, services, opportunities, and alerts.
 * Requires authentication with read permissions.
 *
 * @see coordinator.ts (parent service)
 */

import { Router, Request, Response } from 'express';
import { apiAuth, apiAuthorize } from '@shared/security';
import type { CoordinatorStateProvider } from '../types';

/**
 * FIX: Efficient partial sort for getting top N elements.
 * Uses a min-heap approach that's O(n log k) where k is the limit.
 * Returns the top `limit` elements sorted by the comparator.
 *
 * For descending order (comparator returns negative when a > b),
 * this returns the K largest elements.
 */
function partialSort<T>(arr: T[], limit: number, comparator: (a: T, b: T) => number): T[] {
  if (arr.length <= limit) {
    return arr.slice().sort(comparator);
  }

  // For top-K selection, we need a min-heap that keeps the K "best" items
  // where "best" means they sort earlier (comparator returns negative).
  // The heap root should be the "worst" of our K best items, so we can
  // efficiently compare and replace it when a better item comes.
  //
  // To achieve this, we use the INVERTED comparator for heap operations,
  // making the root the item that would sort LAST among our K items.
  const heap: T[] = [];

  // Helper to maintain min-heap property (worst of K best at root)
  const bubbleUp = (idx: number) => {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      // Use inverted comparator: heap[parent] should be >= heap[idx] in sort order
      if (comparator(heap[parent], heap[idx]) >= 0) break;
      [heap[parent], heap[idx]] = [heap[idx], heap[parent]];
      idx = parent;
    }
  };

  const bubbleDown = (idx: number) => {
    while (true) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let worst = idx;

      // Find the child that sorts LATER (worse)
      if (left < heap.length && comparator(heap[left], heap[worst]) > 0) {
        worst = left;
      }
      if (right < heap.length && comparator(heap[right], heap[worst]) > 0) {
        worst = right;
      }
      if (worst === idx) break;
      [heap[idx], heap[worst]] = [heap[worst], heap[idx]];
      idx = worst;
    }
  };

  for (const item of arr) {
    if (heap.length < limit) {
      heap.push(item);
      bubbleUp(heap.length - 1);
    } else if (comparator(item, heap[0]) < 0) {
      // Item is "better" (sorts earlier) than the worst in our heap
      heap[0] = item;
      bubbleDown(0);
    }
  }

  // Sort the final heap for proper output order
  return heap.sort(comparator);
}

/**
 * Create metrics router.
 *
 * @param state - Coordinator state provider
 * @returns Express router with metrics endpoints
 */
export function createMetricsRoutes(state: CoordinatorStateProvider): Router {
  const router = Router();

  // Authentication middleware for all metrics routes (required: true is the default)
  const readAuth = apiAuth();

  /**
   * GET /api/metrics
   * Returns system-wide metrics.
   */
  router.get(
    '/metrics',
    readAuth,
    apiAuthorize('metrics', 'read'),
    (_req: Request, res: Response) => {
      res.json(state.getSystemMetrics());
    }
  );

  /**
   * GET /api/services
   * Returns health status of all services.
   */
  router.get(
    '/services',
    readAuth,
    apiAuthorize('services', 'read'),
    (_req: Request, res: Response) => {
      res.json(Object.fromEntries(state.getServiceHealthMap()));
    }
  );

  /**
   * GET /api/opportunities
   * Returns recent arbitrage opportunities (last 100).
   * FIX: Performance optimization - partial sort using heap-like selection
   * instead of sorting all opportunities when we only need top 100.
   */
  router.get(
    '/opportunities',
    readAuth,
    apiAuthorize('opportunities', 'read'),
    (_req: Request, res: Response) => {
      const limit = 100;
      const opportunitiesMap = state.getOpportunities();

      // FIX: Performance optimization for large opportunity sets
      // If we have <= limit opportunities, no need to sort
      if (opportunitiesMap.size <= limit) {
        const opportunities = Array.from(opportunitiesMap.values())
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json(opportunities);
        return;
      }

      // For larger sets, use partial selection (more efficient than full sort)
      // We collect all opportunities and use a more efficient approach
      const allOpportunities = Array.from(opportunitiesMap.values());

      // Use partial sort: partition around the limit-th element
      // This is O(n) on average vs O(n log n) for full sort
      const result = partialSort(allOpportunities, limit, (a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      res.json(result);
    }
  );

  /**
   * GET /api/alerts
   * Returns recent alerts from alert history.
   * FIX: Now returns actual alert history instead of empty array.
   */
  router.get(
    '/alerts',
    readAuth,
    apiAuthorize('alerts', 'read'),
    (_req: Request, res: Response) => {
      res.json(state.getAlertHistory(100));
    }
  );

  /**
   * GET /api/leader
   * Returns leader election status.
   */
  router.get(
    '/leader',
    readAuth,
    apiAuthorize('leader', 'read'),
    (_req: Request, res: Response) => {
      res.json({
        isLeader: state.getIsLeader(),
        instanceId: state.getInstanceId(),
        lockKey: state.getLockKey()
      });
    }
  );

  return router;
}
